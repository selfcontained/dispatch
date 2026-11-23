import type { DiffStats } from "@dispatch/shared";
import type { DiffStatsComputation } from "../shared/git/diff-stats.js";
import { readCheckoutView } from "./checkout-view.js";
import {
  isCheckoutView,
  isCheckoutViewData,
  MAX_CHECKOUT_VIEW_BYTES,
  type CheckoutView,
  type CheckoutStatsOutcome,
  isCheckoutQuery,
  isCheckoutReply,
  remotePlacement,
  type CheckoutQuery,
  type CheckoutReply,
  type SessionOperation,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionFromWire,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { inspectCheckout } from "./checkout-inspection.js";
import { AgentError } from "./errors.js";
import { RunnerRevoked, type RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord } from "./types.js";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
} from "./effective-base.js";
import { agentWorkspaceDir, agentDiffPath } from "./workspace-target.js";
import {
  checkoutRunners,
  type CheckoutCommandRunners,
  type CheckoutSession,
} from "../runners/directory.js";
import { controllerPlacement } from "../runners/placement.js";
import { TEST_FILE_PATTERNS } from "../shared/lib/test-file-rule.js";
import { WorkspaceError } from "../shared/lib/workspace-error.js";

type Inspect = Extract<SessionOperation, { kind: "inspectCheckout" }>;
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

const noCommands: CheckoutCommandRunners["local"] = {
  requestSession: () => {
    throw new Error("No checkout command runner was given.");
  },
};

function readRunners(runners: CheckoutReadRunners): CheckoutCommandRunners {
  if (runners && "local" in runners) return runners;
  return { local: noCommands, remote: runners ?? undefined };
}

/** The agent's checkout runner, by its placement. */
function sessionRunner(runners: CheckoutReadRunners, agent: ReadAgent): Runner {
  // This is the arm for agents on the controller's runner; rows built
  // without a placement (older callers' fixtures) are on it too.
  const session = {
    ...agent,
    id: agent.id ?? "",
    placement: agent.placement ?? controllerPlacement,
  } as CheckoutSession;
  const { directory, placement } = checkoutRunners(
    readRunners(runners),
    session
  );
  return directory.for(placement);
}

function remoteOf(runners: CheckoutReadRunners) {
  return readRunners(runners).remote;
}

const target = (agent: { id?: string }) =>
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

/** The built-in runner resolves the same agent-scoped operation in process. */
async function inspectLocalCheckout(agent: AgentRecord, operation: Inspect) {
  const cwd = agentWorkspaceDir(agent);
  if (!cwd || operation.agentId !== agent.id)
    throw new AgentError("The session checkout is unavailable.", 409);
  // The service already passed its explicit base; a native checkout never
  // carries a runner-recorded one (as on main).
  return inspectCheckout(cwd, operation.query, {
    recordedBase: false,
    unresolvedBase: "origin/main",
  });
}

export async function inspectAgentCheckout(
  agent: AgentRecord,
  query: CheckoutQuery,
  runners?: CheckoutReadRunners
): Promise<CheckoutReply> {
  if (!isCheckoutQuery(query))
    throw new AgentError("Invalid checkout query.", 400);
  const operation: Inspect = {
    kind: "inspectCheckout",
    agentId: agent.id,
    query,
  };
  const placement = remotePlacement(agent.cwd);
  if (placement) {
    const remote = remoteOf(runners);
    if (!remote)
      throw new AgentError("The agent’s runner is unavailable.", 409);
    const { value } = await remote.requestSession(placement, operation);
    if (typeof value !== "string")
      throw new AgentError("Missing runner checkout response.", 502);
    let reply: unknown;
    try {
      reply = JSON.parse(value);
    } catch {
      throw new AgentError("Malformed runner checkout response.", 502);
    }
    if (!isCheckoutReply(reply, query))
      throw new AgentError("Invalid runner checkout response.", 502);
    return reply;
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
  return inspectLocalCheckout(agent, operation);
}
/** Resolve the launch placement from the requester, never the display parent. */
export function reviewerWorkspace(owner: AgentRecord) {
  return agentWorkspaceDir(owner) ?? owner.cwd;
}

export function decodeCheckoutView(raw: unknown, view: CheckoutView) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw) > MAX_CHECKOUT_VIEW_BYTES
  )
    throw new AgentError("Invalid runner checkout response.", 502);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgentError("Invalid runner checkout response.", 502);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    "error" in value &&
    [400, 403, 404, 409, 413, 500].includes(Number(value.status)) &&
    typeof value.error === "string"
  )
    throw new AgentError(value.error.slice(0, 256), Number(value.status));
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !isCheckoutViewData(view, value.data)
  )
    throw new AgentError("Invalid runner checkout response.", 502);
  return value.data;
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

/** A view through the session's runner: every view except image bytes. */
async function readRunnerView(
  runner: Runner,
  agent: { id?: string },
  query: Exclude<CheckoutView, { kind: "image" }>
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
  const placement = agent.cwd && remotePlacement(agent.cwd);
  if (placement) {
    const remote = remoteOf(runners);
    if (!remote) throw new AgentError("The runner is unavailable.", 503);
    try {
      const { value } = await remote.requestSession(placement, {
        kind: "viewCheckout",
        agentId: agent.id!,
        query,
      });
      return decodeCheckoutView(value, view);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        error instanceof Error
          ? error.message
          : "Unable to read the runner checkout.",
        error instanceof RunnerRevoked ? 403 : 503
      );
    }
  }
  if (query.kind !== "image")
    return readThrough(() =>
      readRunnerView(sessionRunner(runners, agent), agent, query)
    );
  const cwd = agentDiffPath(agent);
  if (!cwd) throw new AgentError("This agent has no workspace.", 404);
  return readCheckoutView(cwd, query);
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
  const placement = agent.cwd && remotePlacement(agent.cwd);
  const view = {
    kind: "stats",
    baseBranch: null,
    includeUncommitted: true,
  } as const;
  if (placement) {
    const data = await readAgentViewData({ ...agent, id }, view, runners, base);
    return decodeStats(data);
  }
  try {
    const data = await readRunnerView(
      sessionRunner(runners, { ...agent, id }),
      { id },
      { ...view, baseBranch: base }
    );
    return decodeStats(data);
  } catch (error) {
    return { kind: "failure", stats: null, error: readError(error) };
  }
}
