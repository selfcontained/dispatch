import { useQuery } from "@tanstack/react-query";

import type { SlashCommand } from "@/components/app/chat/slash-commands";
import { api } from "@/lib/api";

export function useAgentCommands(
  agentId: string | null,
  active: boolean
): SlashCommand[] {
  const query = useQuery<{ commands: Omit<SlashCommand, "source">[] }>({
    queryKey: ["agent-commands", agentId],
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/commands`),
    enabled: !!agentId && active,
    refetchInterval: active ? 5_000 : false,
    staleTime: 5_000,
  });
  return (query.data?.commands ?? []).map((command) => ({
    ...command,
    source: "agent" as const,
  }));
}
