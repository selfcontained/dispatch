import {
  isCheckoutCommandFile,
  isCheckoutCommandResult,
  remotePlacement,
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord } from "./types.js";

export async function requestCheckoutCommand(
  remote: RemoteRunnerService | undefined,
  agent: AgentRecord,
  operation: Extract<CheckoutCommand, { kind: "read" }>,
  signal?: AbortSignal
): Promise<CheckoutCommandFile | null>;
export async function requestCheckoutCommand(
  remote: RemoteRunnerService | undefined,
  agent: AgentRecord,
  operation: Extract<CheckoutCommand, { kind: "run" }>,
  signal?: AbortSignal
): Promise<CheckoutCommandResult>;
export async function requestCheckoutCommand(
  remote: RemoteRunnerService | undefined,
  agent: AgentRecord,
  operation: CheckoutCommand,
  signal?: AbortSignal
) {
  const placement = remotePlacement(agent.cwd);
  if (!remote || !placement)
    throw new Error("The session runner is unavailable.");
  const { value } = await remote.requestSession(
    placement,
    { kind: "checkoutCommand", agentId: agent.id, operation },
    undefined,
    signal
  );
  let result: unknown;
  try {
    if (typeof value === "string") result = JSON.parse(value);
  } catch {
    // Invalid replies are reported below.
  }
  if (operation.kind === "read" && isCheckoutCommandFile(result)) return result;
  if (operation.kind === "run" && isCheckoutCommandResult(result))
    return result;
  throw new Error("Invalid runner checkout command response.");
}
