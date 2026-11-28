import {
  localSessionRunner,
  enrolledSessionRunner,
  type SessionRunners,
  type SessionRunner,
} from "./session.js";
export type { SessionRunners, SessionRunner } from "./session.js";
import {
  localRunnerSettings,
  enrolledRunnerSettings,
  type RunnerSettings,
} from "./settings-namespace.js";
import {
  RUNNER_WIRE_VERSION,
  MAX_CHECKOUT_COMMAND_FILE_BYTES,
} from "@dispatch/runner-protocol";
import {
  placementOf,
  placementRunner,
  runnerIdToWire,
  samePlacement,
  type Placement,
  type Runner,
  type RunnerDescription,
  type Runners,
} from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "../agents/remote/service.js";
import type { AgentRecord } from "../agents/types.js";
import {
  controllerPlacement,
  LOCAL_RUNNER_ID,
  enrolledRunnerId,
} from "./placement.js";
import { remoteTerminal } from "../terminal/remote.js";
import { createLocalCheckoutRunner, localTerminal } from "./local.js";
import { createEnrolledCheckoutRunner } from "./enrolled/checkout.js";

export type CheckoutSession = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "workspacePath" | "placement"
> & {
  /** Older rows found their worktree through Git; Changes reads it. */
  worktreeBranch?: string | null;
  gitContext?: {
    worktreePath: string;
    isWorktree: boolean;
    repoRoot?: string;
  } | null;
  /** Where the session was launched, as the row records it. */
  launchCwd?: string | null;
  /** Managed from a repository source, including before binding is recorded. */
  repositorySource?: boolean;
};
export type CheckoutCommandRunners = {
  /**
   * The app's local runner. Checkout commands no longer go through it (T14):
   * they run in the child or the workload. Callers still pass it; it leaves
   * with the in-process fallback (T18).
   */
  local?: unknown;
  remote?: RemoteRunnerService;
  /** The local runner child, once the app has started it. */
  child?: () => Runner | undefined;
};

/** What the composition supplies with each runner, by its own rules. */
export type RunnerComposition = {
  settings: RunnerSettings;
  manifestMaxBytes: number | null;
  /**
   * Main's budget for an archive's checkout cleanup, where the runner is
   * this machine (main's 60 s); none where the runner's own transport
   * bounds it.
   */
  cleanupBudgetMs?: number;
  /** How an archive finishes this runner's checkouts (N35: one owner decision). */
  archive: ArchivePolicy;
};

/**
 * The two archive rules in use, as the composition gives them per runner.
 * The archive executor reads only this, never the placement or the row.
 */
export type ArchivePolicy = {
  /**
   * `recorded` (main's): the worktree the row records is the agent's own; no
   * recorded worktree is not managed; another live row naming it keeps it,
   * and removal releases the observed snapshot. `observed` (N35): the
   * runner reports ownership and borrowers, and removal is the caller's
   * decision carried out by the runner (bound release).
   */
  coOwner: "recorded" | "observed";
  /**
   * Who else uses the checkout, for the status read before archive.
   * `recorded` (main's): a row without its own worktree reads its owner's
   * binding, and live rows on the checkout's path that hold it borrow it.
   * `observed` (N35): the runner's own observation, as it reports it.
   */
  borrowers: "recorded" | "observed";
  /** Force removes without observing first (main: no Git status or fetch). */
  forceSkipsObserve: boolean;
  /**
   * What an error anywhere in the cleanup means: `kept` (main's warning,
   * left on disk) or `pending` (retried).
   */
  failure: "kept" | "pending";
  /** The runner refuses to release a checkout while its host still runs. */
  awaitsStoppedHost: boolean;
  /** Retire a borrower host and its binding without touching the owner checkout. */
  discardBorrowedSession?: boolean;
};

/** Main's archive rule, for the runner on this machine. */
export const localArchivePolicy: ArchivePolicy = {
  coOwner: "recorded",
  borrowers: "recorded",
  forceSkipsObserve: true,
  failure: "kept",
  awaitsStoppedHost: false,
};

/** The enrolled runners' archive rule (N35). */
export const enrolledArchivePolicy: ArchivePolicy = {
  coOwner: "observed",
  borrowers: "observed",
  forceSkipsObserve: false,
  failure: "pending",
  awaitsStoppedHost: true,
  discardBorrowedSession: true,
};

export interface CheckoutDirectory extends Runners {
  managementList(includeCleared?: boolean): Promise<
    Array<
      (
        | import("../agents/remote/service.js").RunnerSummary
        | {
            id: string;
            name: string;
            kind: "local";
            engineScope: { kind: "local" };
            engineManagement: true;
            engineCapabilities: true;
            githubManagement: true;
            repositoryPicker: true;
          }
      ) & {
        engineScope: import("@dispatch/runner-protocol/engine-management").EngineScope;
        launchFields: Record<string, string>;
      }
    >
  >;
  for(placement: Placement): Runner & RunnerComposition;
}

const localDescription: RunnerDescription = {
  runnerId: LOCAL_RUNNER_ID,
  displayName: "Local",
  build: { version: "" },
  protocol: RUNNER_WIRE_VERSION,
  engines: [],
  capabilities: {
    sources: { directory: true, repository: true, defaultBaseBranch: "" },
  },
};

export function checkoutRunners(
  runners: CheckoutCommandRunners,
  agent: CheckoutSession
): {
  directory: CheckoutDirectory;
  placement: Placement;
} {
  return {
    directory: runnerDirectory(runners, agent),
    placement: agent.placement,
  };
}

/**
 * Every runner by placement. A session's checkout operations need it bound
 * (`checkoutRunners`); runner-scoped operations, such as GitHub reads, do not.
 */
export function runnerDirectory(
  { remote, child }: CheckoutCommandRunners,
  agent?: CheckoutSession
): CheckoutDirectory {
  return {
    for(selected: Placement): Runner & RunnerComposition {
      const boundAgent =
        agent && samePlacement(selected, agent.placement) ? agent : undefined;
      if (samePlacement(selected, controllerPlacement))
        return Object.assign(
          createLocalCheckoutRunner(boundAgent, localDescription, child?.()),
          {
            settings: localRunnerSettings,
            manifestMaxBytes: null,
            cleanupBudgetMs: boundAgent?.repositorySource ? undefined : 60_000,
            archive: boundAgent?.repositorySource
              ? { ...enrolledArchivePolicy, discardBorrowedSession: false }
              : localArchivePolicy,
          }
        );

      const id = placementRunner(selected);
      return Object.assign(
        createEnrolledCheckoutRunner(
          remote,
          runnerIdToWire(id),
          boundAgent,
          () => {
            return (
              remote
                ?.runnerDescriptions?.()
                .find((runner) => runner.runnerId === id) ?? {
                runnerId: id,
                displayName: runnerIdToWire(id),
                build: { version: "" },
                protocol: RUNNER_WIRE_VERSION,
                engines: [],
                capabilities: {},
              }
            );
          }
        ),
        {
          settings: enrolledRunnerSettings(runnerIdToWire(id)),
          manifestMaxBytes: MAX_CHECKOUT_COMMAND_FILE_BYTES,
          archive: enrolledArchivePolicy,
        }
      );
    },
    async managementList(includeCleared = false) {
      return [
        {
          id: "local",
          name: "Local",
          kind: "local" as const,
          engineScope: { kind: "local" as const },
          launchFields: {},
          engineManagement: true as const,
          engineCapabilities: true as const,
          githubManagement: true as const,
          repositoryPicker: true as const,
        },
        ...((await remote?.list(includeCleared)) ?? []).map((runner) => ({
          ...runner,
          engineScope: { kind: "runner" as const, runnerId: runner.id },
          launchFields: { runner: runner.id },
        })),
      ];
    },
    list() {
      return [localDescription, ...(remote?.runnerDescriptions?.() ?? [])].map(
        (description) => ({
          description,
          placement: placementOf(description.runnerId),
        })
      );
    },
    defaultPlacement: () => controllerPlacement,
  } satisfies CheckoutDirectory;
}

/** Session operations select their carrier once; lifecycle callers use one Runner. */
export function sessionRunnerDirectory(
  { child, remote }: SessionRunners,
  launchWatch: { timeoutMs: number; pollMs: number }
) {
  const local = localSessionRunner(child, () => localDescription, launchWatch);
  const enrolled = new Map<string, SessionRunner>();
  return {
    for(placement: Placement): SessionRunner {
      if (samePlacement(placement, controllerPlacement)) return local;
      const id = runnerIdToWire(placementRunner(placement));
      let runner = enrolled.get(id);
      if (!runner) {
        runner = enrolledSessionRunner(
          remote,
          id,
          () =>
            remote
              ?.runnerDescriptions?.()
              .find((entry) => runnerIdToWire(entry.runnerId) === id) ?? {
              ...localDescription,
              runnerId: placementRunner(placement),
              displayName: id,
            }
        );
        enrolled.set(id, runner);
      }
      return runner;
    },
  };
}

export function terminalBackendFor(
  { remote, child }: CheckoutCommandRunners,
  agent: CheckoutSession
) {
  const location = enrolledRunnerId(agent.placement);
  if (!location) return localTerminal(child, agent);
  if (!remote) throw new Error("The session runner is unavailable.");
  return remoteTerminal(remote, location, agent.id);
}
