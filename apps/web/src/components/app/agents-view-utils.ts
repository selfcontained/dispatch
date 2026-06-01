import { type Agent } from "@/components/app/types";
import { type AgentType, isAgentType } from "@/lib/agent-types";

export const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
export const EXPANDED_AGENT_ID_KEY = "dispatch:expandedAgentId";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export function agentProjectRoot(
  agent: Agent | undefined | null
): string | undefined {
  return agent?.gitContext?.repoRoot?.trim() || agent?.cwd?.trim() || undefined;
}

export function readLastUsedAgentType(): AgentType | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(LAST_USED_TYPE_KEY)?.trim();
  return stored && isAgentType(stored) ? stored : null;
}

export function readExpandedAgentId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(EXPANDED_AGENT_ID_KEY)?.trim();
  return stored && stored.length > 0 ? stored : null;
}

export function isFullAccessEnabled(
  agent: Pick<Agent, "fullAccess" | "agentArgs">
): boolean {
  return (
    agent.fullAccess ||
    agent.agentArgs.includes(CODEX_FULL_ACCESS_ARG) ||
    agent.agentArgs.includes(CLAUDE_FULL_ACCESS_ARG)
  );
}
