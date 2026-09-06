import { useCallback, useMemo } from "react";
import type {
  ChatAnswerRequest,
  ChatAnswerResponse,
  ChatAttachment,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMessage,
  ChatSendRequest,
  ChatSendResponse,
  ChatUserAttachmentInput,
} from "@dispatch/shared";
import {
  type InfiniteData,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

const PAGE_SIZE = 100;

/** Prefix shared by every agent's feed key, for bulk invalidation. */
export const CHAT_QUERY_PREFIX = ["chat"] as const;

export function chatFeedQueryKey(agentId: string | null) {
  return [...CHAT_QUERY_PREFIX, agentId] as const;
}

export type FeedCache = InfiniteData<ChatFeedResponse, string | undefined>;

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

function withoutEntries(
  page: ChatFeedResponse
): Omit<ChatFeedResponse, "entries"> {
  const { entries: _entries, ...meta } = page;
  return meta;
}

/**
 * Structural sharing keyed by entry id.
 *
 * react-query's default shares by position: it walks the old and new pages
 * index by index and keeps an old object wherever the new one is deep-equal.
 * A feed page is a window onto a cursor-paged list, so one new entry shifts
 * every page boundary by one and nothing lines up any more — every entry
 * came back as a fresh object on every refetch, and every memoised post
 * re-rendered (markdown parse, syntax highlighting, the lot) on every status
 * event the agent emitted. Matching by id keeps the unchanged entries, so a
 * refetch that added one message re-renders one message.
 *
 * Pages, the pages array and the whole cache keep their identity too when
 * nothing in them changed, so `useMemo` consumers downstream stay quiet.
 */
export function shareFeedByEntryId(
  prev: FeedCache,
  next: FeedCache
): FeedCache {
  // Keyed by type as well as id: the server namespaces ids per source today
  // (event:/media:/review:/pin:, uuids for the rest), but nothing here should
  // depend on a source it does not control keeping that up.
  const previousById = new Map<string, ChatFeedEntry>();
  for (const page of prev.pages) {
    for (const entry of page.entries) {
      previousById.set(`${entry.type}:${entry.id}`, entry);
    }
  }

  let pagesChanged = prev.pages.length !== next.pages.length;
  const pages = next.pages.map((page, i) => {
    const prevPage = prev.pages[i];
    let entriesChanged =
      !prevPage || prevPage.entries.length !== page.entries.length;
    const entries = page.entries.map((entry, j) => {
      const shared = replaceEqualDeep(
        previousById.get(`${entry.type}:${entry.id}`),
        entry
      );
      if (!entriesChanged && prevPage!.entries[j] !== shared) {
        entriesChanged = true;
      }
      return shared;
    });
    // Everything but the entries is compared generically, so a field added
    // to the response later cannot change on a refetch and go stale here.
    const prevMeta = prevPage ? withoutEntries(prevPage) : undefined;
    const metaSame =
      prevMeta !== undefined &&
      replaceEqualDeep(prevMeta, withoutEntries(page)) === prevMeta;
    if (!entriesChanged && metaSame) return prevPage!;
    pagesChanged = true;
    return {
      ...page,
      entries: entriesChanged ? entries : prevPage!.entries,
    };
  });

  const pageParams = replaceEqualDeep(prev.pageParams, next.pageParams);
  if (!pagesChanged && pageParams === prev.pageParams) return prev;
  return { pages, pageParams };
}

/** The one place the untyped react-query cache boundary is crossed. */
function isFeedCache(data: unknown): data is FeedCache {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { pages?: unknown }).pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams)
  );
}

export function shareFeedCache(oldData: unknown, newData: unknown): unknown {
  return isFeedCache(oldData) && isFeedCache(newData)
    ? shareFeedByEntryId(oldData, newData)
    : replaceEqualDeep(oldData, newData);
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
    structuralSharing: shareFeedCache,
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

/**
 * What the optimistic post can show before the server answers: links and
 * pins as given; files only once the response names them, since the feed
 * renders a file by its stored name and size.
 */
function optimisticAttachments(
  inputs: ChatUserAttachmentInput[]
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const input of inputs) {
    if (input.type === "link") out.push(input);
    else if (input.type === "pin") out.push(input);
  }
  return out;
}

function optimisticUserMessage(
  agentId: string,
  text: string,
  attachments: ChatAttachment[] = []
): ChatMessage {
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
    attachments,
    delivered: null,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function appendToNewestPage(
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

export function replaceMessage(
  cache: FeedCache | undefined,
  matchId: string,
  next: ChatMessage
): FeedCache | undefined {
  if (!cache) return cache;
  // The row may already be here under its real id: `chat.entry` can land
  // before the request that created it returns. Then the placeholder just
  // goes, and the entry that came over the stream (the feed's own shape)
  // stands.
  const alreadyPresent =
    matchId !== next.id &&
    cache.pages.some((page) =>
      page.entries.some(
        (entry) => entry.type === "chat" && entry.message.id === next.id
      )
    );
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      entries: page.entries.flatMap((entry) => {
        if (entry.type !== "chat" || entry.message.id !== matchId) {
          return [entry];
        }
        if (alreadyPresent) return [];
        return [{ ...entry, id: next.id, at: next.createdAt, message: next }];
      }),
    })),
  };
}

/** Where `entry` sits relative to the loaded head, or the row it replaces. */
export type FeedUpsert = {
  cache: FeedCache;
  /**
   * False when the entry belongs somewhere the cache does not hold — older
   * than the newest page's first row, or the cache is empty — so the caller
   * has to fall back to a refetch.
   */
  placed: boolean;
};

/**
 * Put one feed row (from a `chat.entry` event) into the cached pages: in
 * place when its id is already here, otherwise into the newest page at its
 * position by time. The unread count follows agent messages that arrive
 * unread. Identity is preserved everywhere the data did not change, so the
 * rows that did not move do not re-render.
 */
export function upsertFeedEntry(
  cache: FeedCache,
  entry: ChatFeedEntry
): FeedUpsert {
  const newest = cache.pages[0];
  if (!newest) return { cache, placed: false };
  const key = `${entry.type}:${entry.id}`;
  for (let p = 0; p < cache.pages.length; p += 1) {
    const page = cache.pages[p]!;
    const index = page.entries.findIndex(
      (existing) => `${existing.type}:${existing.id}` === key
    );
    if (index === -1) continue;
    const previous = page.entries[index]!;
    const shared = replaceEqualDeep(previous, entry);
    if (shared === previous) return { cache, placed: true };
    const entries = page.entries.slice();
    entries[index] = shared;
    const pages = cache.pages.slice();
    pages[p] = { ...page, entries };
    // The count lives on the newest page whichever page the row is on.
    pages[0] = {
      ...pages[0]!,
      unreadCount: pages[0]!.unreadCount + unreadDelta(previous, entry),
    };
    return { cache: { ...cache, pages }, placed: true };
  }
  const first = newest.entries[0];
  const olderThanHead = first !== undefined && entry.at < first.at;
  if (olderThanHead && (cache.pages.length > 1 || newest.hasMore)) {
    // It belongs below the newest page, on a page this cache may or may not
    // hold; splicing it in would put the cursor chain off.
    return { cache, placed: false };
  }
  let at = newest.entries.length;
  while (at > 0 && newest.entries[at - 1]!.at > entry.at) at -= 1;
  const entries = newest.entries.slice();
  entries.splice(at, 0, entry);
  const pages = cache.pages.slice();
  pages[0] = {
    ...newest,
    entries,
    unreadCount: newest.unreadCount + unreadDelta(null, entry),
  };
  return { cache: { ...cache, pages }, placed: true };
}

function isUnreadAgentMessage(entry: ChatFeedEntry | null): boolean {
  return (
    entry !== null &&
    entry.type === "chat" &&
    entry.message.authorKind === "agent" &&
    entry.message.readAt === null
  );
}

function unreadDelta(
  previous: ChatFeedEntry | null,
  next: ChatFeedEntry
): number {
  return (
    Number(isUnreadAgentMessage(next)) - Number(isUnreadAgentMessage(previous))
  );
}

/** A `chat.read` event: the count moved, nothing on screen did. */
export function applyChatRead(
  cache: FeedCache | undefined,
  unreadCount: number
): FeedCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  if (cache.pages[0]!.unreadCount === unreadCount) return cache;
  const pages = cache.pages.slice();
  pages[0] = { ...pages[0]!, unreadCount };
  return { ...cache, pages };
}

/** Files here are already uploaded (`POST /agents/:id/media`). */
export type ChatSendInput = ChatSendRequest;

export function useSendChatMessage(agentId: string | null) {
  const queryClient = useQueryClient();
  const key = chatFeedQueryKey(agentId);

  return useMutation<
    ChatSendResponse,
    Error,
    ChatSendInput,
    { previous: FeedCache | undefined; tempId: string }
  >({
    mutationFn: async ({ text, attachments }) =>
      api<ChatSendResponse>(`/api/v1/agents/${agentId}/chat/messages`, {
        method: "POST",
        body: JSON.stringify(
          attachments && attachments.length > 0
            ? ({ text, attachments } satisfies ChatSendRequest)
            : ({ text } satisfies ChatSendRequest)
        ),
      }),
    onMutate: async ({ text, attachments }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FeedCache>(key);
      const temp = optimisticUserMessage(
        agentId ?? "",
        text,
        optimisticAttachments(attachments ?? [])
      );
      queryClient.setQueryData<FeedCache>(key, (old) =>
        appendToNewestPage(old, temp)
      );
      return { previous, tempId: temp.id };
    },
    onError: (_err, _input, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
    },
    // No refetch on settle: the stored row reaches the cache as a
    // `chat.entry` event, and the response stands in until it does.
    onSuccess: (data, _input, context) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        replaceMessage(old, context.tempId, data.message)
      );
    },
  });
}

/** Files here are already uploaded, as for `ChatSendInput`. */
export type ChatAnswerInput = ChatAnswerRequest & { messageId: string };

export function useAnswerChatQuestion(agentId: string | null) {
  const queryClient = useQueryClient();
  const key = chatFeedQueryKey(agentId);

  return useMutation<
    ChatAnswerResponse,
    Error,
    ChatAnswerInput,
    { previous: FeedCache | undefined; tempId: string }
  >({
    mutationFn: async ({ messageId, value, label, attachments }) => {
      const body: ChatAnswerRequest = { value };
      if (label) body.label = label;
      if (attachments && attachments.length > 0) body.attachments = attachments;
      return api<ChatAnswerResponse>(
        `/api/v1/agents/${agentId}/chat/messages/${encodeURIComponent(messageId)}/answer`,
        { method: "POST", body: JSON.stringify(body) }
      );
    },
    onMutate: async ({ messageId, value, label, attachments }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FeedCache>(key);
      const temp = {
        ...optimisticUserMessage(
          agentId ?? "",
          label ?? value,
          optimisticAttachments(attachments ?? [])
        ),
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
    // The count is all that moved; the server's `chat.read` says the same
    // to every other tab. Nothing on screen needs a refetch.
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        applyChatRead(old, data.unreadCount)
      );
    },
  });

  return useCallback(
    (upTo?: string) => {
      if (agentId && unreadCount > 0 && !isPending) mutate(upTo);
    },
    [agentId, unreadCount, isPending, mutate]
  );
}
