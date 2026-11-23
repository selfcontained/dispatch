import {
  RUNNER_WIRE_VERSION,
  type CheckoutCommand,
  type CheckoutCommandFile,
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
  legacySessionLocation,
} from "./placement.js";
import { createLocalCheckoutRunner } from "./local.js";
import { createEnrolledCheckoutRunner } from "./enrolled/checkout.js";

export type CheckoutSession = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "workspacePath" | "placement"
> & {
  /** Older rows found their worktree through Git; Changes reads it. */
  gitContext?: { worktreePath: string; isWorktree: boolean } | null;
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

export interface CheckoutRunner extends Runner {
  /** A command guard read: v1's checkout-command family, or the local workload. */
  readManifest(
    operation: Extract<CheckoutCommand, { kind: "read" }>,
    signal?: AbortSignal
  ): Promise<CheckoutCommandFile | null>;
}

interface CheckoutDirectory extends Runners {
  for(placement: Placement): CheckoutRunner;
}

const localDescription: RunnerDescription = {
  runnerId: LOCAL_RUNNER_ID,
  displayName: "Local",
  build: { version: "" },
  protocol: RUNNER_WIRE_VERSION,
  engines: [],
  capabilities: {},
};

export function checkoutRunners(
  { remote, child }: CheckoutCommandRunners,
  agent: CheckoutSession
): {
  directory: CheckoutDirectory;
  placement: Placement;
} {
  const { placement } = agent;
  const location = legacySessionLocation(agent);
  const directory = {
    for(selected: Placement): CheckoutRunner {
      const boundAgent = samePlacement(selected, placement) ? agent : undefined;
      if (samePlacement(selected, controllerPlacement))
        return createLocalCheckoutRunner(
          boundAgent,
          localDescription,
          child?.()
        );

      const id = placementRunner(selected);
      return createEnrolledCheckoutRunner(
        remote,
        runnerIdToWire(id),
        boundAgent ? location : null,
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
      );
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
  return { directory, placement };
}
