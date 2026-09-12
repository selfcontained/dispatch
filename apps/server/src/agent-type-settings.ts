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
 * What the app may create right now: the persisted enabled types plus
 * `dispatch` when and only when the Dispatch Harness flag is on.
 *
 * Every creation and discovery gate reads this, not `getEnabledAgentTypes`:
 * the create route, the reviewer-type route, `dispatch_launch_agent`, persona
 * launches, the plugin routes and the assisted-update driver picker. That is
 * what makes the harness's one switch reach all of them at once.
 *
 * No duplicate is possible: `sanitizeEnabledAgentTypes` drops `dispatch` from
 * the persisted list on every branch, so the append below is the only place
 * it can enter.
 */
export async function getOfferedAgentTypes(pool: Pool): Promise<AgentType[]> {
  const [enabled, harnessEnabled] = await Promise.all([
    getEnabledAgentTypes(pool),
    isDispatchHarnessEnabled(pool),
  ]);
  return harnessEnabled ? [...enabled, "dispatch"] : enabled;
}
