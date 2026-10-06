import type { AgentRecord } from "../agents/manager.js";
import { PERSONA_CONTEXT_ARG } from "../agents/acp/persona-context.js";

/** API responses and SSE share this projection; launch metadata stays server-side. */
export function agentForClient<T extends AgentRecord>(
  agent: T,
  hasStream: boolean
): T & { hasStream: boolean } {
  const agentArgs: string[] = [];
  for (let index = 0; index < agent.agentArgs.length; index++) {
    if (agent.agentArgs[index] === PERSONA_CONTEXT_ARG) {
      index++; // Skip the complete context, retaining it only on the stored record.
    } else {
      agentArgs.push(agent.agentArgs[index]!);
    }
  }
  return { ...agent, agentArgs, hasStream };
}
