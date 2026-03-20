import { type Agent } from "@/components/app/types";

export function sortAgentsByCreatedAtDesc(items: Agent[], activeAgentId?: string | null): Agent[] {
  const eventPriority = (agent: Agent): number => {
    if (activeAgentId && agent.id === activeAgentId) return -1;
    if (agent.latestEvent?.type === "blocked") return 0;
    if (agent.latestEvent?.type === "waiting_user") return 1;
    if (agent.status === "running" || agent.status === "creating" || agent.status === "stopping") return 2;
    return 3;
  };

  const latestActivityAt = (agent: Agent): string =>
    agent.latestEvent?.updatedAt ?? agent.updatedAt ?? agent.createdAt;

  return [...items].sort((a, b) => {
    const priorityDelta = eventPriority(a) - eventPriority(b);
    if (priorityDelta !== 0) return priorityDelta;
    return latestActivityAt(b).localeCompare(latestActivityAt(a));
  });
}
