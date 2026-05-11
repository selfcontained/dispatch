export const AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "terminal",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  terminal: "Terminal",
};

// Agent types that run an AI CLI — eligible for reviews, jobs, and personas.
// Terminal agents are excluded because there's no CLI to drive them.
export const CLI_AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const;
export type CliAgentType = (typeof CLI_AGENT_TYPES)[number];

export function isCliAgentType(value: string): value is CliAgentType {
  return CLI_AGENT_TYPES.includes(value as CliAgentType);
}

export function isAgentType(value: string): value is AgentType {
  return AGENT_TYPES.includes(value as AgentType);
}

export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...AGENT_TYPES];
  }

  const unique = value
    .filter(
      (item): item is AgentType => typeof item === "string" && isAgentType(item)
    )
    .filter((item, index, items) => items.indexOf(item) === index);

  return unique.length > 0 ? unique : [...AGENT_TYPES];
}
