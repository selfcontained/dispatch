import { useCallback, useMemo } from "react";
import type {
  ChatAnswerResponse,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMessage,
  ChatSendResponse,
} from "@dispatch/shared";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

const PAGE_SIZE = 100;

export function chatFeedQueryKey(agentId: string | null) {
  return ["chat", agentId] as const;
}

type FeedCache = InfiniteData<ChatFeedResponse, string | undefined>;

/**
 * One page of the feed. The server hands back an opaque `nextCursor` for the
 * page before this one (null at the oldest page); it is never derived from
 * the entries, so equal timestamps can't skip or repeat a row.
 */
function fetchFeedPage(
  agentId: string | null,
  cursor: string | undefined
): Promise<ChatFeedResponse> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return api<ChatFeedResponse>(
    `/api/v1/agents/${agentId}/chat?${params.toString()}`
  );
}

/**
 * Pages arrive newest-first (page 0 is the initial fetch, later pages are
 * older via `cursor`), each page ascending. Flatten to one ascending list.
 */
function flattenFeedPages(pages: ChatFeedResponse[]): ChatFeedEntry[] {
  const out: ChatFeedEntry[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    out.push(...pages[i]!.entries);
  }
  return out;
}

export type ChatFeedState = {
  entries: ChatFeedEntry[];
  unreadCount: number;
  hasOlder: boolean;
  isLoading: boolean;
  isFetchingOlder: boolean;
  error: Error | null;
  loadOlder: () => void;
  refetch: () => void;
};

export function useChatFeed(agentId: string | null): ChatFeedState {
  const query = useInfiniteQuery<
    ChatFeedResponse,
    Error,
    FeedCache,
    ReturnType<typeof chatFeedQueryKey>,
    string | undefined
  >({
    queryKey: chatFeedQueryKey(agentId),
    queryFn: ({ pageParam }) => fetchFeedPage(agentId, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!agentId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const entries = useMemo(
    () => (query.data ? flattenFeedPages(query.data.pages) : []),
    [query.data]
  );

  // fetchNextPage/refetch are stable; these wrappers are too, so consumers
  // can hang effects and memoised callbacks off them.
  const { fetchNextPage, isFetchingNextPage, refetch: refetchQuery } = query;
  const loadOlder = useCallback(() => {
    if (!isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, isFetchingNextPage]);
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    entries,
    unreadCount: query.data?.pages[0]?.unreadCount ?? 0,
    hasOlder: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingOlder: isFetchingNextPage,
    error: query.error,
    loadOlder,
    refetch,
  };
}

let optimisticSeq = 0;

function optimisticUserMessage(agentId: string, text: string): ChatMessage {
  const now = new Date().toISOString();
  optimisticSeq += 1;
  return {
    id: `optimistic-${optimisticSeq}`,
    agentId,
    authorKind: "user",
    kind: "reply",
    text,
    replyTo: null,
    question: null,
    answer: null,
    attachments: [],
    delivered: null,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function appendToNewestPage(
  cache: FeedCache | undefined,
  message: ChatMessage
): FeedCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  const entry: ChatFeedEntry = {
    type: "chat",
    id: message.id,
    at: message.createdAt,
    message,
  };
  const pages = cache.pages.slice();
  const newest = pages[0]!;
  pages[0] = { ...newest, entries: [...newest.entries, entry] };
  return { ...cache, pages };
}

function replaceMessage(
  cache: FeedCache | undefined,
  matchId: string,
  next: ChatMessage
): FeedCache | undefined {
  if (!cache) return cache;
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      entries: page.entries.map((entry) =>
        entry.type === "chat" && entry.message.id === matchId
          ? { ...entry, id: next.id, at: next.createdAt, message: next }
          : entry
      ),
    })),
  };
}

export function useSendChatMessage(agentId: string | null) {
  const queryClient = useQueryClient();
  const key = chatFeedQueryKey(agentId);

  return useMutation<
    ChatSendResponse,
    Error,
    string,
    { previous: FeedCache | undefined; tempId: string }
  >({
    mutationFn: async (text) =>
      api<ChatSendResponse>(`/api/v1/agents/${agentId}/chat/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onMutate: async (text) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FeedCache>(key);
      const temp = optimisticUserMessage(agentId ?? "", text);
      queryClient.setQueryData<FeedCache>(key, (old) =>
        appendToNewestPage(old, temp)
      );
      return { previous, tempId: temp.id };
    },
    onError: (_err, _text, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (data, _text, context) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        replaceMessage(old, context.tempId, data.message)
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

export type ChatAnswerInput = {
  messageId: string;
  value: string;
  label?: string;
};

export function useAnswerChatQuestion(agentId: string | null) {
  const queryClient = useQueryClient();
  const key = chatFeedQueryKey(agentId);

  return useMutation<
    ChatAnswerResponse,
    Error,
    ChatAnswerInput,
    { previous: FeedCache | undefined; tempId: string }
  >({
    mutationFn: async ({ messageId, value, label }) =>
      api<ChatAnswerResponse>(
        `/api/v1/agents/${agentId}/chat/messages/${encodeURIComponent(messageId)}/answer`,
        {
          method: "POST",
          body: JSON.stringify(label ? { value, label } : { value }),
        }
      ),
    onMutate: async ({ messageId, value, label }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FeedCache>(key);
      const temp = {
        ...optimisticUserMessage(agentId ?? "", label ?? value),
        replyTo: messageId,
      };
      queryClient.setQueryData<FeedCache>(key, (old) =>
        appendToNewestPage(old, temp)
      );
      return { previous, tempId: temp.id };
    },
    onError: (_err, _input, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (data, _input, context) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        replaceMessage(
          replaceMessage(old, data.question.id, data.question),
          context.tempId,
          data.reply
        )
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

/**
 * Marks agent messages read up to `upTo` (or all of them). The returned
 * callback is a no-op while nothing is unread, so callers can fire it from
 * visibility effects without guarding first.
 */
export function useMarkChatRead(
  agentId: string | null,
  unreadCount: number
): (upTo?: string) => void {
  const queryClient = useQueryClient();
  const key = chatFeedQueryKey(agentId);

  const { mutate, isPending } = useMutation<
    { unreadCount: number },
    Error,
    string | undefined
  >({
    mutationFn: async (upTo) =>
      api<{ unreadCount: number }>(`/api/v1/agents/${agentId}/chat/read`, {
        method: "POST",
        body: JSON.stringify(upTo ? { upTo } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) => {
        if (!old || old.pages.length === 0) return old;
        const pages = old.pages.slice();
        pages[0] = { ...pages[0]!, unreadCount: data.unreadCount };
        return { ...old, pages };
      });
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });

  return useCallback(
    (upTo?: string) => {
      if (agentId && unreadCount > 0 && !isPending) mutate(upTo);
    },
    [agentId, unreadCount, isPending, mutate]
  );
}
