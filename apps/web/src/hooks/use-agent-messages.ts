import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// The message shape is defined once on the server and imported type-only —
// esbuild erases this import, so nothing from the server reaches the web
// bundle.
import type { StoredMessage } from "../../../server/src/messages/store";

import { api } from "@/lib/api";

/**
 * Wire shape of a message row. GET /api/v1/agents/:id/messages returns
 * `MessageStore.listForAgent()` verbatim, but the /api/v1/history detail query
 * projects the same row without the repo-root columns and reuses this type, so
 * those two fields are omitted rather than aliased through.
 */
export type AgentMessage = Omit<
  StoredMessage,
  "senderRepoRoot" | "recipientRepoRoot"
>;

type MessagesPayload = {
  messages: AgentMessage[];
  unreadCount: number;
};

function messagesQueryKey(agentId: string | null) {
  return ["messages", agentId];
}

export function useAgentMessages(agentId: string | null): {
  messages: AgentMessage[];
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery<MessagesPayload>({
    queryKey: messagesQueryKey(agentId),
    queryFn: async () => {
      const payload = await api<MessagesPayload>(
        `/api/v1/agents/${agentId}/messages`
      );
      return {
        messages: payload.messages ?? [],
        unreadCount: payload.unreadCount ?? 0,
      };
    },
    enabled: !!agentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  return { messages: data?.messages ?? [], isLoading };
}

export function useAgentUnreadCount(agentId: string | null): number {
  const { data } = useQuery<MessagesPayload>({
    queryKey: messagesQueryKey(agentId),
    queryFn: async () => {
      const payload = await api<MessagesPayload>(
        `/api/v1/agents/${agentId}/messages`
      );
      return {
        messages: payload.messages ?? [],
        unreadCount: payload.unreadCount ?? 0,
      };
    },
    enabled: !!agentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  return data?.unreadCount ?? 0;
}

export function useMarkMessagesRead(agentId: string | null): () => void {
  const queryClient = useQueryClient();

  const { mutate } = useMutation({
    mutationFn: async () => {
      if (!agentId) return;
      await api(`/api/v1/agents/${agentId}/messages/read`, { method: "POST" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: messagesQueryKey(agentId),
        exact: true,
      });
    },
  });

  const unreadCount = useAgentUnreadCount(agentId);

  return useCallback(() => {
    if (agentId && unreadCount > 0) mutate();
  }, [agentId, unreadCount, mutate]);
}
