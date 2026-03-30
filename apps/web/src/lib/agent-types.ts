export const AGENT_TYPES = ["codex", "claude", "opencode"] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode"
};

export function isAgentType(value: string): value is AgentType {
  return AGENT_TYPES.includes(value as AgentType);
}

export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...AGENT_TYPES];
  }

  const unique = value
    .filter((item): item is AgentType => typeof item === "string" && isAgentType(item))
    .filter((item, index, items) => items.indexOf(item) === index);

  return unique.length > 0 ? unique : [...AGENT_TYPES];
}
