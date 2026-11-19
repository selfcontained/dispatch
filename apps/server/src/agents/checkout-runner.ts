import {
  isCheckoutQuery,
  isCheckoutReply,
  remotePlacement,
  type CheckoutQuery,
  type CheckoutReply,
  type SessionOperation,
} from "@dispatch/runner-protocol";
import { inspectCheckout } from "./checkout-inspection.js";
import { AgentError } from "./errors.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord } from "./types.js";
import { agentWorkspaceDir } from "./workspace-target.js";

type Inspect = Extract<SessionOperation, { kind: "inspectCheckout" }>;

/** The built-in runner resolves the same agent-scoped operation in process. */
async function inspectLocalCheckout(agent: AgentRecord, operation: Inspect) {
  const cwd = agentWorkspaceDir(agent);
  if (!cwd || operation.agentId !== agent.id)
    throw new AgentError("The session checkout is unavailable.", 409);
  return inspectCheckout(cwd, operation.query);
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
  let reply: unknown;
  if (placement) {
    if (!remote)
      throw new AgentError("The agent’s runner is unavailable.", 409);
    const { value } = await remote.requestSession(placement, operation);
    if (typeof value !== "string")
      throw new AgentError("Missing runner checkout response.", 502);
    try {
      reply = JSON.parse(value);
    } catch {
      throw new AgentError("Malformed runner checkout response.", 502);
    }
  } else {
    reply = await inspectLocalCheckout(agent, operation);
  }
  if (!isCheckoutReply(reply, query))
    throw new AgentError("Invalid runner checkout response.", 502);
  return reply;
}

/** Resolve the launch placement from the requester, never the display parent. */
export function reviewerWorkspace(owner: AgentRecord) {
  return agentWorkspaceDir(owner) ?? owner.cwd;
}
