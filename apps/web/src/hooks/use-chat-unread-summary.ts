import type { ChatUnreadSummary } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";

import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import { api } from "@/lib/api";

export type { ChatUnreadSummary } from "@dispatch/shared";

export type ChatAgentUnread = ChatUnreadSummary["agents"][string];

export const CHAT_UNREAD_QUERY_KEY = ["chat-unread"] as const;

const NONE: ChatAgentUnread = { unread: 0, pendingQuestions: 0 };

/**
 * One app-wide query for every agent's unread chat state, refreshed on
 * `chat.changed` (see use-sse.ts). Off entirely while the chat surface flag
 * is off, so the sidebar shows nothing chat-related in that mode.
 */
export function useChatUnreadSummary(): ChatUnreadSummary | undefined {
  const { enabled } = useChatSurfaceEnabled();
  const { data } = useQuery<ChatUnreadSummary>({
    queryKey: CHAT_UNREAD_QUERY_KEY,
    queryFn: () => api<ChatUnreadSummary>("/api/v1/chat/unread"),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return enabled ? data : undefined;
}

export function useAgentChatUnread(agentId: string): ChatAgentUnread {
  const summary = useChatUnreadSummary();
  return summary?.agents[agentId] ?? NONE;
}
