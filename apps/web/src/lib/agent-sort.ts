import { type Agent } from "@/components/app/types";

export function sortAgentsByCreatedAtDesc(items: Agent[]): Agent[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
