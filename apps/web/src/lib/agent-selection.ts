import type { Agent } from "@/components/app/types";
import { agentScopeProjectId } from "@/lib/agent-lineage";

/**
 * Live list membership and scope both matter; a foreign agent can exist.
 * Scope follows the agent's sidebar card, so a child is in its parent's scope.
 */
export function isAgentInScope(
  agent: Agent,
  projectId: string | null,
  agents: readonly Agent[]
) {
  return (
    agent.status !== "archiving" &&
    (!projectId || agentScopeProjectId(agent, agents) === projectId)
  );
}
