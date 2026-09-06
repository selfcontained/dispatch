/**
 * Agent-type tables and predicates, re-exported from the shared server
 * module so the web client always matches what the server accepts (see
 * apps/server/src/shared/agent-types.ts). Display labels and web-only
 * helpers live here.
 */
import type { AgentRecord } from "@dispatch/shared";

import {
  type AgentType,
  isCliAgentType,
} from "../../../server/src/shared/agent-types";

export {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  type AgentType,
  type CliAgentType,
} from "../../../server/src/shared/agent-types";

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  dsh: "Dispatch",
  terminal: "Terminal",
};

export function sortAgentTypes<T extends AgentType>(types: T[]): T[] {
  return [...types].sort((a, b) => {
    if (a === "terminal") return 1;
    if (b === "terminal") return -1;
    return AGENT_TYPE_LABELS[a].localeCompare(AGENT_TYPE_LABELS[b]);
  });
}

/** The reviewer runs as the agent's own kind unless a choice was saved. */
export function defaultReviewAgentType(
  agent: Partial<Pick<AgentRecord, "type" | "reviewAgentType">>
): AgentType {
  return (
    agent.reviewAgentType ?? (isCliAgentType(agent.type) ? agent.type : "codex")
  );
}
