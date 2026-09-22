import type { AgentActivity } from "@dispatch/shared";

import { type Agent } from "@/components/app/types";

/**
 * The agent's activity as the server derived it. A partial agent (a test
 * fixture, an optimistic cache entry) has none yet; its status is all there
 * is to go on.
 */
export function agentActivity(
  agent: Pick<Agent, "activity" | "status" | "setupPhase">
): AgentActivity {
  if (agent.activity) return agent.activity;
  if (agent.status === "creating" || agent.setupPhase) return "starting";
  if (agent.status === "error") return "blocked";
  return agent.status === "running" ? "idle" : "stopped";
}
