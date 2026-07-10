import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type AgentMessage = {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  delivered: boolean;
  readAt: string | null;
  createdAt: string;
};

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
