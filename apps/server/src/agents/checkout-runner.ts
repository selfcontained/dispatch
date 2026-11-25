import type { DiffStats } from "@dispatch/shared";
import type { DiffStatsComputation } from "./checkout-result.js";
import {
  isCheckoutView,
  type CheckoutView,
  type CheckoutStatsOutcome,
  isCheckoutQuery,
  type CheckoutQuery,
  type CheckoutReply,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  displayPath,
  sessionFromWire,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { AgentError } from "./errors.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord } from "./types.js";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
} from "./effective-base.js";
import { agentWorkspaceDir } from "./workspace-target.js";
import {
  checkoutRunners,
  type CheckoutCommandRunners,
  type CheckoutSession,
} from "../runners/directory.js";
import { checkoutReadPlacement } from "../runners/placement.js";
import { TEST_FILE_PATTERNS } from "@dispatch/runner-protocol";
import { WorkspaceError } from "@dispatch/runner-protocol";

/**
 * The runners an agent's checkout reads go through, or (as older callers
 * pass) just the remote service: local reads then run in this process.
 */
export type CheckoutReadRunners =
  | CheckoutCommandRunners
  | RemoteRunnerService
  | null
  | undefined;
type ReadAgent = ComparisonBaseAgent &
  Partial<Pick<AgentRecord, "id" | "placement">>;

function readRunners(runners: CheckoutReadRunners): CheckoutCommandRunners {
  if (runners && "local" in runners) return runners as CheckoutCommandRunners;
  return { remote: (runners as RemoteRunnerService | null) ?? undefined };
}

/** The agent's checkout runner, by its placement. */
export function sessionRunner(
  runners: CheckoutReadRunners,
  agent: ReadAgent,
  legacyView?: CheckoutView
): Runner {
  const session = {
    ...agent,
    id: agent.id ?? "",
    placement: agent.placement ?? checkoutReadPlacement(agent.cwd),
  } as CheckoutSession;
  const { directory, placement } = checkoutRunners(
    readRunners(runners),
    session,
    legacyView
  );
  return directory.for(placement);
}

export const target = (agent: { id?: string }) =>
  ({ session: sessionFromWire(agent.id ?? ""), checkout: "current" }) as const;

/**
 * A runner's failure as the error the app answers with today: a status the
 * workload or adapter recorded comes back as the same error class, an OS
 * error keeps its code, and a runner that cannot answer is unavailable.
 */
function readError(error: unknown): Error {
  if (!(error instanceof RunnerCallError)) return error as Error;
  const details = (error.details ?? {}) as {
    status?: unknown;
    class?: unknown;
    errno?: unknown;
  };
  if (typeof details.status === "number") {
    if (details.class === "agent")
      return new AgentError(error.message, details.status);
    // The workload's only 500 is the generic read failure: answer it as the
    // app does for any failure without a status.
    if (details.status !== 500)
      return new WorkspaceError(error.message, details.status);
    return new Error(error.message);
  }
  switch (error.code) {
    case "unavailable":
    case "unknown_outcome":
    case "timeout":
    case "cancelled":
    case "fenced":
      return new AgentError(error.message, 503);
  }
  const plain = new Error(error.message) as NodeJS.ErrnoException;
  if (typeof details.errno === "string") plain.code = details.errno;
  return plain;
}

async function readThrough<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw readError(error);
  }
}

/** Contract stats as the app's `DiffStats`, in the order the app writes them. */
function statsFromRunner(
  data: Res<"checkout.stats">
): (DiffStats & { outcome?: CheckoutStatsOutcome }) | null {
  if (data === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data))
    out[key === "excluded" ? "excludingTests" : key] = value;
  return out as DiffStats & { outcome?: CheckoutStatsOutcome };
}

/** A contract diff as the app's: `excluded` is its `isTest`, in place. */
function diffFromRunner(data: Res<"checkout.diff">) {
  if (!data || !("files" in data)) return data;
  return {
    ...data,
    files: data.files.map((file) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(file))
        out[key === "excluded" ? "isTest" : key] = value;
      return out;
    }),
  };
}

export async function inspectAgentCheckout(
  agent: AgentRecord,
  query: CheckoutQuery,
  runners?: CheckoutReadRunners
): Promise<CheckoutReply> {
  if (!isCheckoutQuery(query))
    throw new AgentError("Invalid checkout query.", 400);
  if (query.kind === "roots") {
    const roots = await readThrough(() =>
      sessionRunner(runners, agent).call("git.roots", { target: target(agent) })
    );
    return {
      kind: "roots",
      checkoutRoot:
        roots.checkoutRoot === null ? null : displayPath(roots.checkoutRoot),
      repositoryRoot:
        roots.repositoryRoot === null
          ? null
          : displayPath(roots.repositoryRoot),
    };
  }
  // Every query is a contract read on the agent's runner; a local one that
  // the child cannot serve runs the same workload in the adapter.
  if (query.kind === "listFiles") {
    const listing = await readThrough(() =>
      sessionRunner(runners, agent).call("checkout.list", {
        target: target(agent),
        path: query.path,
        filesOnly: true,
      })
    );
    return {
      kind: "listFiles",
      names: listing.entries.map(({ name }) => name),
    };
  }
  if (query.kind === "readFile") {
    const { path } = query;
    const file = await readThrough(() =>
      sessionRunner(runners, agent).call("checkout.read", {
        target: target(agent),
        path,
        encoding: "utf8",
        maxBytes: null,
      })
    );
    return { kind: "readFile", content: file?.data ?? null };
  }
  if (query.kind === "defaultBranchFiles") {
    const files = await readThrough(() =>
      sessionRunner(runners, agent).call("checkout.defaultFiles", {
        target: target(agent),
        dirs: query.directories,
        wait: query.waitForRefresh,
      })
    );
    return { kind: "defaultBranchFiles", ...files };
  }
  if (query.kind === "changes") {
    const base = query.baseBranch;
    const changes = await readThrough(() =>
      sessionRunner(runners, agent).call("checkout.changes", {
        target: target(agent),
        base,
        // Native owner reviews attempt this ref if the usual probes fail.
        fallback: ["origin/main"],
      })
    );
    return { kind: "changes", ...changes };
  }
  throw new AgentError("Invalid checkout query.", 400);
}
/** Resolve the launch placement from the requester, never the display parent. */
export function reviewerWorkspace(owner: AgentRecord) {
  return agentWorkspaceDir(owner) ?? owner.cwd;
}

/**
 * Resolve the selected session once for both foreground and background reads.
 * `comparisonBase` is the service's effective base (`agentComparisonBase`);
 * both executors receive it explicitly, and an explicit view base wins.
 */
export async function readAgentView(
  agent: ReadAgent,
  view: CheckoutView,
  runners?: CheckoutReadRunners,
  comparisonBase?: string | null
): Promise<unknown> {
  const base =
    "baseBranch" in view &&
    view.baseBranch === null &&
    comparisonBase === undefined
      ? await agentComparisonBase(agent, "changes")
      : (comparisonBase ?? null);
  const data = await readAgentViewData(agent, view, runners, base);
  if (view.kind === "stats" && data !== null) return decodeStats(data).stats;
  return data;
}

function decodeStats(data: unknown): DiffStatsComputation {
  if (data === null) return { kind: "no-data", stats: null };
  const { outcome, ...stats } = data as DiffStats & {
    outcome?: CheckoutStatsOutcome;
  };
  return outcome === "partial"
    ? { kind: "partial", stats, error: new Error("Runner Git probe failed") }
    : { kind: "success", stats };
}

/** A view through the session's runner. */
async function readRunnerView(
  runner: Runner,
  agent: { id?: string },
  query: CheckoutView
): Promise<unknown> {
  const at = target(agent);
  switch (query.kind) {
    case "directory":
      return runner.call("checkout.list", { target: at, path: query.path });
    case "preview":
      return runner.call("checkout.preview", { target: at, path: query.path });
    case "index":
      return runner.call("checkout.index", {
        target: at,
        generation: query.generation,
      });
    case "stats":
      return statsFromRunner(
        await runner.call("checkout.stats", {
          target: at,
          base: query.baseBranch,
          uncommitted: query.includeUncommitted,
          exclude: [...TEST_FILE_PATTERNS],
        })
      );
    case "diff":
    case "fileDiff":
      return diffFromRunner(
        await runner.call("checkout.diff", {
          target: at,
          base: query.baseBranch,
          uncommitted: query.includeUncommitted,
          whitespace: query.ignoreWhitespace ? "ignore" : "show",
          exclude: [...TEST_FILE_PATTERNS],
          ...(query.kind === "fileDiff" && { path: query.path }),
        })
      );
    case "image":
      return (
        await runner.call("checkout.image", {
          target: at,
          base: query.baseBranch,
          uncommitted: query.includeUncommitted,
          path: query.path,
          side: query.side,
        })
      ).bytes;
  }
}

async function readAgentViewData(
  agent: ReadAgent,
  view: CheckoutView,
  runners: CheckoutReadRunners,
  comparisonBase: string | null
): Promise<unknown> {
  if (!isCheckoutView(view))
    throw new AgentError("Invalid workspace path.", 400);
  const query =
    "baseBranch" in view
      ? { ...view, baseBranch: view.baseBranch ?? comparisonBase }
      : view;
  return readThrough(() =>
    readRunnerView(sessionRunner(runners, agent, query), agent, query)
  );
}

export async function readAgentStats(
  id: string,
  agent: ComparisonBaseAgent & Partial<Pick<AgentRecord, "placement">>,
  runners?: CheckoutReadRunners,
  comparisonBase?: string | null
): Promise<DiffStatsComputation> {
  const base =
    comparisonBase === undefined
      ? await agentComparisonBase(agent, "changes")
      : comparisonBase;
  const view = {
    kind: "stats",
    baseBranch: base,
    includeUncommitted: true,
  } as const;
  try {
    const data = await readRunnerView(
      sessionRunner(runners, { ...agent, id }, view),
      { id },
      view
    );
    return decodeStats(data);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    return { kind: "failure", stats: null, error: readError(error) };
  }
}
