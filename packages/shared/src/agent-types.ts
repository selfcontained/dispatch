/**
 * The agent-type table.
 *
 * Both apps have to agree on this member list: the server validates settings,
 * job and persona launches against it, and the web client builds its agent
 * pickers and settings toggles from it. Predicates and the server-only
 * plugin-agent subset stay in `apps/server/src/shared/agent-types.ts`, which
 * re-exports these so its existing importers are untouched.
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
