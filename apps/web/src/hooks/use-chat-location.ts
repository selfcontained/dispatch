import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type ChatLocation = {
  streamId: string;
  threadId: string | null;
  blockId: string;
};

/** Read stored locations without starting an agent or creating history. */
export function useChatLocation(agentId: string | null, blockId?: string) {
  return useQuery({
    queryKey: ["agent-chat-location", agentId, blockId ?? null],
    queryFn: () =>
      api<ChatLocation | null>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/chat-location${blockId ? `?blockId=${encodeURIComponent(blockId)}` : ""}`
      ),
    enabled: agentId !== null,
    retry: false,
    staleTime: 60_000,
  });
}
