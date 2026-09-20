import { type Agent } from "@/components/app/types";

/** Why nothing can be sent to this agent right now, or null when it can. */
export function composerDisabledReason(
  agent: Agent | null,
  feed: { isLoading: boolean; error: Error | null } = {
    isLoading: false,
    error: null,
  }
): string | null {
  if (!agent) return "Select an agent to chat with.";
  if (feed.error) return "Chat couldn't load — retry above before sending.";
  if (feed.isLoading) return "Loading the chat…";
  if (agent.status === "creating") return "The agent is still starting up.";
  if (agent.status !== "running") {
    return "The agent is not running. Start it to send messages.";
  }
  return null;
}
