import { useCallback, useMemo } from "react";
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

  const { data: messages = [], isLoading } = useQuery<AgentMessage[]>({
    queryKey: ["messages", agentId],
    queryFn: async () => {
      const payload = await api<{ messages: AgentMessage[] }>(
        `/api/v1/agents/${agentId}/messages`
      );
      return payload.messages ?? [];
    },
    enabled: !!agentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const unreadCount = useMemo(
    () =>
      messages.filter(
        (m) => m.recipientAgentId === agentId && m.readAt === null
      ).length,
    [messages, agentId]
  );

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
