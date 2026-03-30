import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

export const AGENT_TYPES = ["codex", "claude", "opencode"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

const ENABLED_AGENT_TYPES_KEY = "enabled_agent_types";

function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.includes(value as AgentType);
}

export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...AGENT_TYPES];
  }

  const unique = value.filter(isAgentType).filter((type, index, types) => types.indexOf(type) === index);
  return unique.length > 0 ? unique : [...AGENT_TYPES];
}

export async function getEnabledAgentTypes(pool: Pool): Promise<AgentType[]> {
  const raw = await getSetting(pool, ENABLED_AGENT_TYPES_KEY);
  if (!raw) {
    return [...AGENT_TYPES];
  }

  try {
    return sanitizeEnabledAgentTypes(JSON.parse(raw));
  } catch {
    return [...AGENT_TYPES];
  }
}

export async function setEnabledAgentTypes(pool: Pool, agentTypes: AgentType[]): Promise<AgentType[]> {
  const sanitized = sanitizeEnabledAgentTypes(agentTypes);
  await setSetting(pool, ENABLED_AGENT_TYPES_KEY, JSON.stringify(sanitized));
  return sanitized;
}
