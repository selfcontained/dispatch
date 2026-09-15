import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";
import { isDispatchHarnessEnabled } from "./dispatch-harness-settings.js";
import {
  DEFAULT_ENABLED_AGENT_TYPES,
  sanitizeEnabledAgentTypes,
  type AgentType,
} from "./shared/agent-types.js";

export {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  DEFAULT_ENABLED_AGENT_TYPES,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  type AgentType,
  type CliAgentType,
} from "./shared/agent-types.js";

const ENABLED_AGENT_TYPES_KEY = "enabled_agent_types";

export async function getEnabledAgentTypes(pool: Pool): Promise<AgentType[]> {
  const raw = await getSetting(pool, ENABLED_AGENT_TYPES_KEY);
  if (!raw) {
    return [...DEFAULT_ENABLED_AGENT_TYPES];
  }

  try {
    return sanitizeEnabledAgentTypes(JSON.parse(raw));
  } catch {
    return [...DEFAULT_ENABLED_AGENT_TYPES];
  }
}

export async function setEnabledAgentTypes(
  pool: Pool,
  agentTypes: AgentType[]
): Promise<AgentType[]> {
  const sanitized = sanitizeEnabledAgentTypes(agentTypes);
  await setSetting(pool, ENABLED_AGENT_TYPES_KEY, JSON.stringify(sanitized));
  return sanitized;
}

/**
 * Creation gates use this list; settings use the persisted list, which
 * excludes `dispatch`. Its separate opt-in flag is the only way to offer it.
 */
export async function getOfferedAgentTypes(pool: Pool): Promise<AgentType[]> {
  const [enabled, harnessEnabled] = await Promise.all([
    getEnabledAgentTypes(pool),
    isDispatchHarnessEnabled(pool),
  ]);
  return harnessEnabled ? [...enabled, "dispatch"] : enabled;
}
