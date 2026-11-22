import type { QueryClient } from "@tanstack/react-query";

import type { Agent } from "@/components/app/types";
import { toast } from "@/components/ui/toast";

/**
 * Archiving carries on in the background once the server accepts it, so the
 * result is a toast: when the agent leaves the list, or lands on an error.
 */
export function announceArchiveResult(client: QueryClient, agent: Agent): void {
  let sawArchiving = false;
  const check = (): boolean => {
    const agents = client.getQueryData<Agent[]>(["agents"]);
    if (!agents) return false;
    const current = agents.find(({ id }) => id === agent.id);
    if (!current) {
      toast.success(`Agent “${agent.name}” archived.`);
      return true;
    }
    if (current.status === "archiving") sawArchiving = true;
    if (sawArchiving && current.status === "error") {
      toast.error(`Couldn’t archive “${agent.name}”.`, {
        error: current.lastError ?? "The archive failed.",
        description: "The agent is still in your list. Archive it again.",
      });
      return true;
    }
    // Rolled back: a later removal is not this archive's.
    return sawArchiving && current.status !== "archiving";
  };
  if (check()) return;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "agents")
      return;
    if (check()) unsubscribe();
  });
}
