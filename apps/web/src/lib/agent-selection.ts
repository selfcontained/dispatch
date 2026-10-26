import type { Agent } from "@/components/app/types";

/** Live list membership and scope both matter; a foreign agent can exist. */
export function isAgentInScope(agent: Agent, projectId: string | null) {
  return (
    agent.status !== "archiving" &&
    (!projectId || agent.projectId === projectId)
  );
}
