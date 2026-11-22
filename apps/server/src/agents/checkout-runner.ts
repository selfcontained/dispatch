import type { DiffStats } from "@dispatch/shared";
import {
  getDiffStatsComputation,
  type DiffStatsComputation,
} from "../shared/git/diff-stats.js";
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
import { inspectCheckout } from "./checkout-inspection.js";
import { AgentError } from "./errors.js";
import { RunnerRevoked, type RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord } from "./types.js";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
} from "./effective-base.js";
import { agentWorkspaceDir, agentDiffPath } from "./workspace-target.js";

type Inspect = Extract<SessionOperation, { kind: "inspectCheckout" }>;

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
  remote?: RemoteRunnerService
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
  agent: ComparisonBaseAgent & { id: string },
  view: CheckoutView,
  remote?: RemoteRunnerService | null,
  comparisonBase?: string | null
): Promise<unknown> {
  const base =
    "baseBranch" in view &&
    view.baseBranch === null &&
    comparisonBase === undefined
      ? await agentComparisonBase(agent, "changes")
      : (comparisonBase ?? null);
  const data = await readAgentViewData(agent, view, remote, base);
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

async function readAgentViewData(
  agent: ComparisonBaseAgent & { id: string },
  view: CheckoutView,
  remote: RemoteRunnerService | null | undefined,
  comparisonBase: string | null
): Promise<unknown> {
  if (!isCheckoutView(view))
    throw new AgentError("Invalid workspace path or options.", 400);
  const query =
    "baseBranch" in view
      ? { ...view, baseBranch: view.baseBranch ?? comparisonBase }
      : view;
  const placement = agent.cwd && remotePlacement(agent.cwd);
  if (placement) {
    if (!remote) throw new AgentError("The runner is unavailable.", 503);
    try {
      const { value } = await remote.requestSession(placement, {
        kind: "viewCheckout",
        agentId: agent.id,
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
  const cwd =
    "baseBranch" in view ? agentDiffPath(agent) : agentWorkspaceDir(agent);
  if (!cwd) {
    if (view.kind === "stats") return null;
    throw new AgentError("This agent has no workspace.", 404);
  }
  return readCheckoutView(cwd, query);
}

export async function readAgentStats(
  id: string,
  agent: ComparisonBaseAgent,
  remote?: RemoteRunnerService | null,
  comparisonBase?: string | null
): Promise<DiffStatsComputation> {
  const base =
    comparisonBase === undefined
      ? await agentComparisonBase(agent, "changes")
      : comparisonBase;
  const placement = agent.cwd && remotePlacement(agent.cwd);
  if (placement) {
    const data = await readAgentViewData(
      { ...agent, id },
      { kind: "stats", baseBranch: null, includeUncommitted: true },
      remote,
      base
    );
    return decodeStats(data);
  }
  const target = agentDiffPath(agent);
  return target
    ? getDiffStatsComputation(target, base)
    : { kind: "no-data", stats: null };
}
