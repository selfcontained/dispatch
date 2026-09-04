/**
 * Agent-type predicates over the shared table.
 *
 * The member lists themselves live in `@dispatch/shared` so the web client
 * agrees on them without reaching into the server. They are re-exported here
 * because ~15 server modules (and apps/web/src/lib/agent-types.ts) already
 * import them from this path. Keep this module dependency-free: no node
 * imports, no browser globals.
 */

import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  DEFAULT_ENABLED_AGENT_TYPES,
  type AgentType,
  type CliAgentType,
} from "@dispatch/shared";

export { AGENT_TYPES, CLI_AGENT_TYPES, DEFAULT_ENABLED_AGENT_TYPES };
export type { AgentType, CliAgentType };

export function isCliAgentType(value: unknown): value is CliAgentType {
  return (
    typeof value === "string" && CLI_AGENT_TYPES.includes(value as CliAgentType)
  );
}

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.includes(value as AgentType);
}

// Agent types with a Dispatch plugin (skills for the CLI itself, installed
// via `claude plugin` / `codex plugin`). Single source of truth for this —
// keep launch-guidance trimming (agents/tmux/command-builder.ts) and plugin
// update detection (shared/plugin-status.ts) both pointed at this list
// rather than each declaring their own, so a third CLI shipping a plugin
// only needs one line changed.
export const PLUGIN_AGENT_TYPES = ["claude", "codex"] as const;
export type PluginAgentType = (typeof PLUGIN_AGENT_TYPES)[number];

export function isPluginAgentType(value: unknown): value is PluginAgentType {
  return (
    typeof value === "string" &&
    (PLUGIN_AGENT_TYPES as readonly string[]).includes(value)
  );
}

export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ENABLED_AGENT_TYPES];
  }

  const unique = value
    .filter(isAgentType)
    .filter((type, index, types) => types.indexOf(type) === index);
  return unique.length > 0 ? unique : [...DEFAULT_ENABLED_AGENT_TYPES];
}
