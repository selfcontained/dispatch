import type { AgentLatestEventType } from "./types.js";

/** Every value accepted for an agent's latest status event. */
export const AGENT_LATEST_EVENT_TYPES = [
  "working",
  "blocked",
  "waiting_user",
  "done",
  "idle",
] as const satisfies readonly AgentLatestEventType[];

export function isAgentLatestEventType(
  value: unknown
): value is AgentLatestEventType {
  return (
    typeof value === "string" &&
    AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType)
  );
}
