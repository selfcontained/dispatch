import { useQuery } from "@tanstack/react-query";
import type { HarnessCommandsResponse } from "@dispatch/shared";

import type { SlashItem } from "@/components/app/chat/chat-composer";
import { api } from "@/lib/api";

export function harnessCommandsQueryKey(agentId: string | null) {
  return ["harness-commands", agentId] as const;
}

/** The slash commands the engine advertised, shaped for the composer's "/" menu. */
export function useHarnessCommands(agentId: string | null): SlashItem[] {
  const query = useQuery({
    queryKey: harnessCommandsQueryKey(agentId),
    queryFn: () =>
      api<HarnessCommandsResponse>(
        `/api/v1/agents/${agentId}/harness/commands`
      ),
    enabled: agentId !== null,
    // The list changes when the session comes up or a command is added; a
    // minute of staleness covers that.
    staleTime: 60_000,
  });
  return (query.data?.commands ?? []).map((c) => ({
    name: c.name,
    description: c.input?.hint
      ? `${c.description} · ${c.input.hint}`
      : c.description,
  }));
}
