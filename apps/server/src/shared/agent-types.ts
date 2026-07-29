/**
 * Agent-type tables and predicates.
 *
 * Single source of truth shared by the server (settings sanitization, job
 * and persona agent validation) and the web client (agent pickers, settings
 * toggles) — web imports this module directly across the workspace boundary
 * (see apps/web/src/lib/agent-types.ts). Keep it dependency-free: no node
 * imports, no browser globals.
 */

export const AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "terminal",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

// Agent types that run an AI CLI — eligible for jobs, review assignment, and
// persona launches. Terminal agents are excluded because they don't run a CLI.
export const CLI_AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const;
export type CliAgentType = (typeof CLI_AGENT_TYPES)[number];

export function isCliAgentType(value: unknown): value is CliAgentType {
  return (
    typeof value === "string" && CLI_AGENT_TYPES.includes(value as CliAgentType)
  );
}

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.includes(value as AgentType);
}

export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...AGENT_TYPES];
  }

  const unique = value
    .filter(isAgentType)
    .filter((type, index, types) => types.indexOf(type) === index);
  return unique.length > 0 ? unique : [...AGENT_TYPES];
}
