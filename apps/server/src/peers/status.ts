import type { AgentStatus } from "../agents/types.js";

const AGENT_STATUSES = [
  "creating",
  "running",
  "stopping",
  "stopped",
  "archiving",
  "error",
  "unknown",
] as const satisfies readonly AgentStatus[];

/**
 * Narrow a status string that came off the wire. A peer runs its own build and
 * may know statuses this one does not, so an unrecognized value is dropped
 * rather than written through — a shadow with a bogus status would break every
 * consumer that switches on it.
 */
export function asAgentStatus(value: string | undefined): AgentStatus | undefined {
  return AGENT_STATUSES.includes(value as (typeof AGENT_STATUSES)[number])
    ? (value as AgentStatus)
    : undefined;
}
