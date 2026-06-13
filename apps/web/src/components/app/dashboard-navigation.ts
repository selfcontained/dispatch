import type { NavigateFunction } from "react-router-dom";

import type { Agent } from "@/components/app/types";
import { agentRoute } from "@/lib/agent-routes";

export async function openAgentFromJobs(
  navigate: NavigateFunction,
  agent: Agent
): Promise<void> {
  navigate(agentRoute(agent.id));
}
