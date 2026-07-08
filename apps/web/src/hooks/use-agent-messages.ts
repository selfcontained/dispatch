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

export function useAgentMessages(agentId: string | null): {
  messages: AgentMessage[];
  unreadCount: number;
  markRead: () => void;
  isLoading: boolean;
} {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{
    messages: AgentMessage[];
    unreadCount: number;
  }>({
    queryKey: ["messages", agentId],
    queryFn: async () => {
      const payload = await api<{
        messages: AgentMessage[];
        unreadCount: number;
      }>(`/api/v1/agents/${agentId}/messages`);
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

  const messages = data?.messages ?? [];
  // Server-derived (uses the partial unread index) so the badge stays accurate
  // even though the message list is capped.
  const unreadCount = data?.unreadCount ?? 0;

  const markMutation = useMutation({
    mutationFn: async () => {
      if (!agentId) return;
      await api(`/api/v1/agents/${agentId}/messages/read`, { method: "POST" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["messages", agentId],
        exact: true,
      });
    },
  });

  const { mutate: markMutate } = markMutation;
  const markRead = useCallback(() => {
    if (agentId && unreadCount > 0) markMutate();
  }, [agentId, unreadCount, markMutate]);

  return { messages, unreadCount, markRead, isLoading };
}
