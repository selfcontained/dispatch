/**
 * The web side of an agent's stream (docs/design/blocks.md): the cursor-paged
 * feed of blocks, turns and status marks, the thread behind one block, and
 * the writes a person makes — a post, an answer, a form submission, a state
 * change, a reaction, a mark-read. Every write patches the react-query cache
 * optimistically and lets the stored row arrive as a `stream.entry`.
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  Block,
  BlockOption,
  BlockReaction,
  BlockReviewInput,
  ChatAttachment,
  ChatTurnEntry,
  ChatUserAttachmentInput,
  StreamAnswerRequest,
  StreamAnswerResponse,
  StreamBlockEntry,
  StreamEntry,
  StreamFeedResponse,
  StreamPostRequest,
  StreamPostResponse,
  StreamReactionRequest,
  StreamReactionResponse,
  StreamStateRequest,
  StreamSubmitRequest,
  StreamThreadReadResponse,
  StreamThreadResponse,
} from "@dispatch/shared";
import {
  type InfiniteData,
  type QueryClient,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  type UseMutationResult,
  hashKey,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { agentSwitchValidationMode } from "@/lib/agent-switch-validation";

const PAGE_SIZE = 100;

/**
 * How far the newest page may grow with live rows before the feed is
 * refetched to rebase its pages. Without a bound, a tab left open on a
 * chatty agent would accumulate every status row it ever saw.
 */
export const LIVE_HEAD_ROWS = PAGE_SIZE * 2;

/** Prefix shared by every stream's feed key, for bulk invalidation. */
export const STREAM_QUERY_PREFIX = ["stream"] as const;

/** The feed of one stream, keyed by the root agent whose stream it is. */
export function streamFeedQueryKey(rootId: string | null) {
  return [...STREAM_QUERY_PREFIX, rootId] as const;
}

/** One block's thread: its root and its replies. */
export function threadQueryKey(rootId: string | null, blockId: string | null) {
  return [...STREAM_QUERY_PREFIX, rootId, "thread", blockId] as const;
}

export type FeedCache = InfiniteData<StreamFeedResponse, string | undefined>;

function streamPath(rootId: string | null): string {
  return `/api/v1/streams/${encodeURIComponent(rootId ?? "")}`;
}

function blockPath(rootId: string | null, blockId: string): string {
  return `${streamPath(rootId)}/blocks/${encodeURIComponent(blockId)}`;
}

/**
 * One page of the feed. The server hands back an opaque `nextCursor` for the
 * page before this one (null at the oldest page); it is never derived from
 * the entries, so equal timestamps can't skip or repeat a row.
 */
function fetchFeedPage(
  rootId: string | null,
  cursor: string | undefined
): Promise<StreamFeedResponse> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  if (agentSwitchValidationMode === "before") {
    params.set("fullTurnDetails", "1");
  }
  return api<StreamFeedResponse>(
    `${streamPath(rootId)}/blocks?${params.toString()}`
  );
}

/**
 * Pages arrive newest-first (page 0 is the initial fetch, later pages are
 * older via `cursor`), each page ascending. Flatten to one ascending list.
 */
function flattenFeedPages(pages: StreamFeedResponse[]): StreamEntry[] {
  const out: StreamEntry[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    out.push(...pages[i]!.entries);
  }
  return out;
}

/**
 * Every page's names for the agents it mentions, merged. A fresh object
 * whenever the pages change; the feed context keeps one identity while
 * the names themselves stay the same.
 */
function mergeAgentNames(
  pages: readonly StreamFeedResponse[] | undefined
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const page of pages ?? []) Object.assign(names, page.agentNames);
  return names;
}

function withoutEntries(
  page: StreamFeedResponse
): Omit<StreamFeedResponse, "entries"> {
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
 * refetch that added one block re-renders one block.
 *
 * Pages, the pages array and the whole cache keep their identity too when
 * nothing in them changed, so `useMemo` consumers downstream stay quiet.
 */
export function shareFeedByEntryId(
  prev: FeedCache,
  next: FeedCache
): FeedCache {
  // Keyed by type as well as id: the server namespaces ids per source today
  // (event: for status rows, uuids for the rest), but nothing here should
  // depend on a source it does not control keeping that up.
  const previousById = new Map<string, StreamEntry>();
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

export type StreamFeedState = {
  entries: StreamEntry[];
  /** Names for the agents the loaded pages mention, archived ones included. */
  agentNames: Record<string, string>;
  unreadCount: number;
  hasOlder: boolean;
  isLoading: boolean;
  isFetchingOlder: boolean;
  error: Error | null;
  loadOlder: () => void;
  refetch: () => void;
};

/**
 * The feed as the cache holds it, without fetching: for a view beside the
 * feed (the drawer's thread page) that reads the turns the Chat tab keeps
 * current and should not start a second load of its own.
 */
export function useStreamFeedCache(rootId: string | null): StreamEntry[] {
  // A read of the cache, not an observer: a `useQuery` here, even with
  // `skipToken`, would hand the query its options, and the next refetch
  // (an invalidation from a stream event) would find no fetcher and fail
  // the feed for the pane that owns it. Subscribe to the cache instead.
  const queryClient = useQueryClient();
  const hash = hashKey(streamFeedQueryKey(rootId));
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) onChange();
      }),
    [hash, queryClient]
  );
  const data = useSyncExternalStore(
    subscribe,
    () => queryClient.getQueryCache().get<FeedCache>(hash)?.state.data
  );
  return useMemo(
    () => (data ? data.pages.flatMap((page) => page.entries) : []),
    [data]
  );
}

function feedQueryOptions(rootId: string | null) {
  return {
    queryKey: streamFeedQueryKey(rootId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchFeedPage(rootId, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (lastPage: StreamFeedResponse) =>
      lastPage.nextCursor ?? undefined,
    enabled: !!rootId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    structuralSharing: shareFeedCache,
  } as const;
}

export function useStreamFeed(rootId: string | null): StreamFeedState {
  const query = useInfiniteQuery<
    StreamFeedResponse,
    Error,
    FeedCache,
    ReturnType<typeof streamFeedQueryKey>,
    string | undefined
  >(feedQueryOptions(rootId));

  const entries = useMemo(
    () => (query.data ? flattenFeedPages(query.data.pages) : []),
    [query.data]
  );

  const pages = query.data?.pages;
  const agentNames = useMemo(() => mergeAgentNames(pages), [pages]);

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
    agentNames,
    unreadCount: query.data?.pages[0]?.unreadCount ?? 0,
    hasOlder: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingOlder: isFetchingNextPage,
    error: query.error,
    loadOlder,
    refetch,
  };
}

/**
 * A value derived from the feed, for a view that needs only that: it loads
 * the feed like `useStreamFeed` but renders again only when the derived
 * value changes, not on every stream update. The value is compared
 * structurally, so `select` may build a fresh object each time.
 */
export function useStreamFeedSelect<T>(
  rootId: string | null,
  select: (
    entries: StreamEntry[],
    across: { openInputs: readonly Block[]; threadLinks: readonly Block[] }
  ) => T
): { data: T | undefined; isLoading: boolean } {
  const query = useInfiniteQuery<
    StreamFeedResponse,
    Error,
    T,
    ReturnType<typeof streamFeedQueryKey>,
    string | undefined
  >({
    ...feedQueryOptions(rootId),
    select: (data) =>
      select(flattenFeedPages(data.pages), {
        openInputs: data.pages[0]?.openInputs ?? [],
        threadLinks: data.pages[0]?.threadLinks ?? [],
      }),
  });
  return { data: query.data, isLoading: query.isLoading };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export type ThreadState = {
  root: Block | null;
  replies: Block[];
  /** Names for the agents the thread mentions, archived ones included. */
  agentNames: Record<string, string> | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
};

/** The thread under one top-level block, live while the panel is open. */
export function useThread(
  rootId: string | null,
  blockId: string | null
): ThreadState {
  const query = useQuery<StreamThreadResponse, Error>({
    queryKey: threadQueryKey(rootId, blockId),
    queryFn: () =>
      api<StreamThreadResponse>(`${blockPath(rootId, blockId ?? "")}/thread`),
    enabled: !!rootId && !!blockId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);
  return {
    root: query.data?.root ?? null,
    replies: query.data?.replies ?? [],
    agentNames: query.data?.agentNames,
    isLoading: query.isLoading,
    error: query.error,
    refetch,
  };
}

/** Full settled activity is fetched only while its fold is open. */
export function useTurnDetail(rootId: string, blockId: string) {
  const query = useQuery<{ turn: ChatTurnEntry }, Error>({
    queryKey: [...streamFeedQueryKey(rootId), "turn-detail", blockId],
    queryFn: () =>
      api<{ turn: ChatTurnEntry }>(`${blockPath(rootId, blockId)}/turn`),
    staleTime: Infinity,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return {
    turn: query.data?.turn ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Put one reply into a cached thread: in place when its id is already here,
 * otherwise at its position by time. Nothing happens when the thread was
 * never fetched; its first fetch will carry the row.
 */
export function upsertThreadReply(
  thread: StreamThreadResponse | undefined,
  reply: Block
): StreamThreadResponse | undefined {
  if (!thread) return thread;
  if (reply.id === thread.root.id) {
    const shared = replaceEqualDeep(thread.root, reply);
    return shared === thread.root ? thread : { ...thread, root: shared };
  }
  // A block the root shows is drawn by the root, not listed as a reply.
  if (showsBlock(thread.root, reply.id)) {
    const root = mapShownBlock(thread.root, reply.id, (previous) =>
      replaceEqualDeep(previous, {
        ...reply,
        blocks: reply.blocks ?? previous.blocks,
      })
    );
    return root === thread.root ? thread : { ...thread, root };
  }
  const index = thread.replies.findIndex((r) => r.id === reply.id);
  if (index !== -1) {
    const previous = thread.replies[index]!;
    const shared = replaceEqualDeep(previous, reply);
    if (shared === previous) return thread;
    const replies = thread.replies.slice();
    replies[index] = shared;
    return { ...thread, replies };
  }
  let at = thread.replies.length;
  while (at > 0 && thread.replies[at - 1]!.createdAt > reply.createdAt) {
    at -= 1;
  }
  const replies = thread.replies.slice();
  replies.splice(at, 0, reply);
  return { ...thread, replies };
}

function removeThreadReplyObject(
  thread: StreamThreadResponse | undefined,
  target: Block
): StreamThreadResponse | undefined {
  if (!thread || !thread.replies.includes(target)) return thread;
  return { ...thread, replies: thread.replies.filter((r) => r !== target) };
}

/** A block that carries a link or a pull request, as the Inbox lists them. */
function carriesLink(block: Block): boolean {
  return (
    block.kind === "link" ||
    block.attachments.some((a) => a.type === "link" || a.type === "pr")
  );
}

/** Put a block in a list by id (or take it out), keeping the list's order. */
function upsertListed(
  list: readonly Block[],
  block: Block,
  keep: boolean,
  at: "start" | "end"
): Block[] | null {
  const index = list.findIndex((b) => b.id === block.id);
  if (!keep && index === -1) return null;
  const next = list.slice();
  if (!keep) next.splice(index, 1);
  else if (index !== -1) next[index] = block;
  else if (at === "start") next.unshift(block);
  else next.push(block);
  return next;
}

/**
 * Keep what the first page carries from across the stream in step with a
 * block that changed: an agent's question or form for people is listed
 * while it is open and leaves once answered, and a post in a thread that
 * carries a link joins the thread links — wherever in the stream either
 * was posted.
 */
export function syncAcrossStream(
  cache: FeedCache | undefined,
  block: Block
): FeedCache | undefined {
  const first = cache?.pages[0];
  if (!cache || !first) return cache;
  const open =
    block.author.kind === "agent" &&
    block.toAgentId === null &&
    ((block.kind === "question" &&
      block.state?.answer === undefined &&
      block.state?.cancellation === undefined) ||
      (block.kind === "form" &&
        block.state?.submission === undefined &&
        block.state?.cancellation === undefined));
  const inputs = upsertListed(first.openInputs ?? [], block, open, "end");
  const links =
    block.threadId !== null
      ? upsertListed(
          first.threadLinks ?? [],
          block,
          carriesLink(block),
          "start"
        )
      : null;
  if (!inputs && !links) return cache;
  return {
    ...cache,
    pages: [
      {
        ...first,
        ...(inputs ? { openInputs: inputs } : {}),
        ...(links ? { threadLinks: links } : {}),
      },
      ...cache.pages.slice(1),
    ],
  };
}

/**
 * A reply landed under a top-level block: the feed's copy of that block
 * shows one more reply and a newer last-reply time. A republish of a reply
 * the row already counts (its delivery settling) carries a `createdAt` no
 * newer than `lastReplyAt`, so it moves nothing.
 */
export function bumpReplyCount(
  cache: FeedCache | undefined,
  reply: Block
): FeedCache | undefined {
  if (!cache || !reply.threadId) return cache;
  return mapBlock(cache, reply.threadId, (block) => {
    // A block the host shows is not a reply to it.
    if (showsBlock(block, reply.id)) return block;
    const last = block.lastReplyAt ?? null;
    if (last !== null && reply.createdAt <= last) return block;
    return {
      ...block,
      replyCount: (block.replyCount ?? 0) + 1,
      lastReplyAt: reply.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Cache surgery
// ---------------------------------------------------------------------------

/** A fresh block id for a post; the server stores the row under it. */
function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // No secure context (plain-http LAN access): assemble a v4-shaped id.
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
    c === "x" ? hex() : ((Math.random() * 4) | 8).toString(16)
  );
}

/**
 * What the optimistic post can show before the server answers: links as
 * given; files only once the response names them, since the feed renders a
 * file by its stored name and size.
 */
function optimisticAttachments(
  inputs: ChatUserAttachmentInput[]
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const input of inputs) {
    if (input.type === "link") out.push(input);
  }
  return out;
}

/** A person's text block, addressed to the agent, before the server sees it. */
export function optimisticUserBlock(
  id: string,
  streamId: string,
  text: string,
  attachments: ChatAttachment[] = [],
  thread: { threadId: string; replyTo: string } | null = null,
  /** The agent it is for; the stream's root when not given. */
  to?: string,
  /** A review left by hand: the block is a `review`; its findings arrive with the stored row. */
  review?: BlockReviewInput
): Block {
  const now = new Date().toISOString();
  const base = {
    id,
    streamId,
    author: { kind: "user" } as const,
    toAgentId: to ?? streamId,
    threadId: thread?.threadId ?? null,
    replyTo: thread?.replyTo ?? null,
    text,
    attachments,
    delivered: null,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  };
  if (review) {
    return {
      ...base,
      kind: "review",
      data: { summary: review.summary },
      state: { blocks: [] },
    };
  }
  return { ...base, kind: "text", data: null, state: null };
}

function entryOf(block: Block): StreamBlockEntry {
  return { type: "block", id: block.id, at: block.createdAt, block };
}

/**
 * The placeholder shares its id with the stored row, so it is told apart
 * by identity: once the stream has replaced it, the object is gone from
 * the cache and there is nothing left to remove.
 */
function rollbackPlaceholder(
  queryClient: QueryClient,
  key: ReturnType<typeof streamFeedQueryKey>,
  placeholder: StreamEntry
): void {
  queryClient.setQueryData<FeedCache>(key, (old) =>
    removeEntryObject(old, placeholder)
  );
  void queryClient.invalidateQueries({ queryKey: key, exact: true });
}

/** Take a placeholder block out of the feed, by identity. */
function removeEntryObjectByBlock(
  cache: FeedCache | undefined,
  placeholder: Block
): FeedCache | undefined {
  const entry = cache?.pages
    .flatMap((page) => page.entries)
    .find((e) => e.type === "block" && e.block === placeholder);
  return entry ? removeEntryObject(cache, entry) : cache;
}

function removeEntryObject(
  cache: FeedCache | undefined,
  target: StreamEntry
): FeedCache | undefined {
  if (!cache) return cache;
  let changed = false;
  const pages = cache.pages.map((page) => {
    if (!page.entries.includes(target)) return page;
    changed = true;
    return { ...page, entries: page.entries.filter((e) => e !== target) };
  });
  return changed ? { ...cache, pages } : cache;
}

export function appendToNewestPage(
  cache: FeedCache | undefined,
  block: Block
): FeedCache | undefined {
  return appendEntry(cache, entryOf(block));
}

function appendEntry(
  cache: FeedCache | undefined,
  entry: StreamEntry
): FeedCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  const pages = cache.pages.slice();
  const newest = pages[0]!;
  pages[0] = { ...newest, entries: [...newest.entries, entry] };
  return { ...cache, pages };
}

/**
 * Rewrite one block wherever it sits. The mapper returning the same object
 * leaves the cache untouched; everything else keeps its identity.
 */
/**
 * Apply `map` to the block with this id, wherever it is: the block itself,
 * or one it shows (a review on a launch card, a finding in a review), at
 * any depth. The same object back when nothing matched.
 */
export function mapShownBlock(
  block: Block,
  blockId: string,
  map: (block: Block) => Block
): Block {
  if (block.id === blockId) return map(block);
  if (!block.blocks || block.blocks.length === 0) return block;
  let changed = false;
  const blocks = block.blocks.map((shown) => {
    const next = mapShownBlock(shown, blockId, map);
    if (next !== shown) changed = true;
    return next;
  });
  return changed ? ({ ...block, blocks } as Block) : block;
}

/** Whether `block` shows the block with this id, at any depth. */
export function showsBlock(block: Block, blockId: string): boolean {
  return (block.blocks ?? []).some(
    (shown) => shown.id === blockId || showsBlock(shown, blockId)
  );
}

export function mapBlock(
  cache: FeedCache | undefined,
  blockId: string,
  map: (block: Block) => Block
): FeedCache | undefined {
  if (!cache) return cache;
  let changed = false;
  const pages = cache.pages.map((page) => {
    let touched = false;
    const entries = page.entries.map((entry) => {
      if (entry.type !== "block") return entry;
      const next = mapShownBlock(entry.block, blockId, map);
      if (next === entry.block) return entry;
      touched = true;
      return { ...entry, at: next.createdAt, block: next };
    });
    if (!touched) return page;
    changed = true;
    return { ...page, entries };
  });
  return changed ? { ...cache, pages } : cache;
}

export function replaceBlock(
  cache: FeedCache | undefined,
  matchId: string,
  next: Block
): FeedCache | undefined {
  if (!cache) return cache;
  // The row may already be here under its real id: `stream.entry` can land
  // before the request that created it returns. Then the placeholder just
  // goes, and the entry that came over the stream (the feed's own shape,
  // attachment dimensions and all) stands. The same applies to a row
  // replaced under its own id: the response is the bare stored block, so
  // when the cache already holds this version of it, the cache's copy wins.
  const alreadyPresent =
    matchId !== next.id &&
    cache.pages.some((page) =>
      page.entries.some(
        (entry) => entry.type === "block" && entry.block.id === next.id
      )
    );
  let changed = false;
  const pages = cache.pages.map((page) => {
    const entries = page.entries.flatMap((entry) => {
      if (entry.type !== "block" || entry.block.id !== matchId) {
        return [entry];
      }
      if (alreadyPresent) {
        changed = true;
        return [];
      }
      if (
        entry.block.id === next.id &&
        entry.block.updatedAt === next.updatedAt
      ) {
        return [entry];
      }
      changed = true;
      return [{ ...entry, id: next.id, at: next.createdAt, block: next }];
    });
    return entries.length === page.entries.length && !changed
      ? page
      : { ...page, entries };
  });
  return changed ? { ...cache, pages } : cache;
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
 * Put one feed row (from a `stream.entry` event) into the cached pages: in
 * place when its id is already here, otherwise into the newest page at its
 * position by time. The unread count follows agent blocks that arrive
 * unread. Identity is preserved everywhere the data did not change, so the
 * rows that did not move do not re-render.
 */
export function upsertFeedEntry(
  cache: FeedCache,
  entry: StreamEntry
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
    // A replacement never moves the count: read state only ever changes
    // through mark-read, which announces its own count (`stream.read`), and
    // a cached row's `readAt` can lag it.
    return { cache: { ...cache, pages }, placed: true };
  }
  // The server orders rows by microsecond time, then source, then id; the
  // wire carries milliseconds. Two rows in the same millisecond can't be
  // ordered here, so their placement is left to a refetch — and so is a row
  // at or below the newest page's oldest row when pages sit under it, since
  // it may belong below the cursor.
  const first = newest.entries[0];
  const belowHead = first !== undefined && entry.at <= first.at;
  if (belowHead && (cache.pages.length > 1 || newest.hasMore)) {
    return { cache, placed: false };
  }
  if (newest.entries.some((existing) => existing.at === entry.at)) {
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
    unreadCount: newest.unreadCount + Number(isUnreadAgentBlock(entry)),
  };
  return { cache: { ...cache, pages }, placed: true };
}

/** An agent's block for people that the user has not seen. */
export function isUnreadAgentBlock(entry: StreamEntry): boolean {
  return (
    entry.type === "block" &&
    entry.block.author.kind === "agent" &&
    entry.block.toAgentId === null &&
    entry.block.readAt === null
  );
}

/** Which rows a mark-read stamped, so the cache can say the same. */
export type StreamReadMark = { readAt: string; upToAt: string | null };

/**
 * A mark-read landed: take the server's count, and stamp the cached agent
 * blocks it covered — every unread one created at or before `upToAt`
 * (all of them when null) — so the rows agree with the count. Rows and
 * pages it did not touch keep their identity.
 */
export function applyStreamRead(
  cache: FeedCache | undefined,
  unreadCount: number,
  mark?: StreamReadMark
): FeedCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  let changed = cache.pages[0]!.unreadCount !== unreadCount;
  const pages = cache.pages.map((page) => {
    if (!mark) return page;
    let touched = false;
    const entries = page.entries.map((entry) => {
      if (
        !isUnreadAgentBlock(entry) ||
        entry.type !== "block" ||
        (mark.upToAt !== null && entry.block.createdAt > mark.upToAt)
      ) {
        return entry;
      }
      touched = true;
      return { ...entry, block: { ...entry.block, readAt: mark.readAt } };
    });
    if (!touched) return page;
    changed = true;
    return { ...page, entries };
  });
  if (!changed) return cache;
  pages[0] = { ...pages[0]!, unreadCount };
  return { ...cache, pages };
}

/** Drop one block by id, wherever it sits; everything else keeps identity. */
export function removeBlock(
  cache: FeedCache | undefined,
  blockId: string
): FeedCache | undefined {
  if (!cache) return cache;
  let changed = false;
  const pages = cache.pages.map((page) => {
    const entries = page.entries.filter(
      (entry) => entry.type !== "block" || entry.block.id !== blockId
    );
    if (entries.length === page.entries.length) return page;
    changed = true;
    return { ...page, entries };
  });
  return changed ? { ...cache, pages } : cache;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** Files here are already uploaded (`POST /agents/:id/files`). */
export type StreamPostInput = StreamPostRequest;

/**
 * A person's post: to the root agent (a prompt), to another agent in its
 * tree when `to` is set, or a reply under a top-level block when `replyTo`
 * is set. A top-level post shows in the feed at once; a reply shows in its
 * thread, and the root's reply line counts it.
 */
export function usePostBlock(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  const mutation = useMutation<
    StreamPostResponse,
    Error,
    StreamPostInput & { id: string },
    { placeholder: Block; threadKey: readonly unknown[] | null }
  >({
    mutationFn: async ({
      id,
      to,
      text,
      replyTo,
      attachments,
      review,
      interrupt,
    }) => {
      const body: StreamPostRequest = { id, text };
      if (interrupt) body.interrupt = true;
      if (to) body.to = to;
      if (replyTo) body.replyTo = replyTo;
      if (attachments && attachments.length > 0) body.attachments = attachments;
      if (review) body.review = review;
      return api<StreamPostResponse>(`${streamPath(rootId)}/blocks`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onMutate: async ({ id, to, text, replyTo, attachments, review }) => {
      const placeholder = optimisticUserBlock(
        id,
        rootId ?? "",
        text,
        optimisticAttachments(attachments ?? []),
        replyTo ? { threadId: replyTo, replyTo } : null,
        to,
        review
      );
      if (replyTo) {
        const threadKey = threadQueryKey(rootId, replyTo);
        await queryClient.cancelQueries({ queryKey: threadKey, exact: true });
        queryClient.setQueryData<StreamThreadResponse>(threadKey, (old) =>
          upsertThreadReply(old, placeholder)
        );
        return { placeholder, threadKey };
      }
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<FeedCache>(key, (old) =>
        appendEntry(old, entryOf(placeholder))
      );
      return { placeholder, threadKey: null };
    },
    // A failure may still have stored the row (the response was what got
    // lost), and its `stream.entry` may already have replaced the
    // placeholder: take out only the placeholder object, never a snapshot
    // that would erase the row, and let a refetch settle what happened.
    onError: (_err, _input, context) => {
      if (!context) return;
      if (context.threadKey) {
        queryClient.setQueryData<StreamThreadResponse>(
          context.threadKey,
          (old) => removeThreadReplyObject(old, context.placeholder)
        );
        void queryClient.invalidateQueries({
          queryKey: context.threadKey,
          exact: true,
        });
        return;
      }
      const entries = queryClient
        .getQueryData<FeedCache>(key)
        ?.pages.flatMap((page) => page.entries);
      const placeholderEntry = entries?.find(
        (entry) => entry.type === "block" && entry.block === context.placeholder
      );
      if (placeholderEntry) {
        rollbackPlaceholder(queryClient, key, placeholderEntry);
      } else {
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
    },
    // No refetch on settle: the stored row reaches the cache as a
    // `stream.entry` event, and the response stands in until it does.
    onSuccess: (data, _input, context) => {
      if (context?.threadKey) {
        queryClient.setQueryData<StreamThreadResponse>(
          context.threadKey,
          (old) => upsertThreadReply(old, data.block)
        );
        queryClient.setQueryData<FeedCache>(key, (old) =>
          bumpReplyCount(old, data.block)
        );
        return;
      }
      // A message for one child lands in the child's own thread, on its
      // card: the placeholder leaves the channel for that thread.
      if (data.block.threadId) {
        const reply = data.block;
        queryClient.setQueryData<FeedCache>(key, (old) =>
          bumpReplyCount(
            context ? removeEntryObjectByBlock(old, context.placeholder) : old,
            reply
          )
        );
        queryClient.setQueryData<StreamThreadResponse>(
          threadQueryKey(rootId, reply.threadId),
          (old) => upsertThreadReply(old, reply)
        );
        return;
      }
      queryClient.setQueryData<FeedCache>(key, (old) =>
        replaceBlock(old, data.block.id, data.block)
      );
    },
  });
  return useWithMintedId(mutation);
}

/**
 * Hands each post a fresh id before it starts, keeping the caller's input
 * shape; the wrappers are as stable as `mutate`/`mutateAsync` themselves,
 * which ChatPane relies on.
 */
function useWithMintedId<TData, TInput extends object, TContext>(
  mutation: UseMutationResult<TData, Error, TInput & { id: string }, TContext>
) {
  const { mutate, mutateAsync } = mutation;
  const mutateMinted = useCallback(
    (input: TInput, options?: Parameters<typeof mutate>[1]) =>
      mutate({ ...input, id: newBlockId() }, options),
    [mutate]
  );
  const mutateAsyncMinted = useCallback(
    (input: TInput, options?: Parameters<typeof mutateAsync>[1]) =>
      mutateAsync({ ...input, id: newBlockId() }, options),
    [mutateAsync]
  );
  return { ...mutation, mutate: mutateMinted, mutateAsync: mutateAsyncMinted };
}

// ---------------------------------------------------------------------------
// Answers, submissions, state
// ---------------------------------------------------------------------------

/** Files here are already uploaded, as for `StreamPostInput`. */
export type StreamAnswerInput = StreamAnswerRequest & { blockId: string };

/** The option an answer chose, as the block's state records it. */
export function answeredOption(
  value: string,
  label: string | undefined
): BlockOption {
  return label ? { label, value } : { label: value, value };
}

/**
 * Answer a question block. The question's own state shows the answer at
 * once; the user's reply block lives in the question's thread, where the
 * server files it, so the feed itself gains no row.
 */
export function useAnswerQuestion(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  const mutation = useMutation<
    StreamAnswerResponse,
    Error,
    StreamAnswerInput & { id: string },
    { previous: Block | null }
  >({
    mutationFn: async ({ id, blockId, value, label, attachments }) => {
      const body: StreamAnswerRequest = { id, value };
      if (label) body.label = label;
      if (attachments && attachments.length > 0) body.attachments = attachments;
      return api<StreamAnswerResponse>(`${blockPath(rootId, blockId)}/answer`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onMutate: async ({ id, blockId, value, label }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      let previous: Block | null = null;
      const now = new Date().toISOString();
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, blockId, (block) => {
          if (block.kind !== "question") return block;
          previous = block;
          return {
            ...block,
            state: {
              ...block.state,
              answer: {
                value,
                ...(label ? { label } : {}),
                by: { kind: "user" },
                blockId: id,
                at: now,
              },
            },
          };
        })
      );
      return { previous };
    },
    onError: (_err, { blockId }, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<FeedCache>(key, (old) =>
          mapBlock(old, blockId, (block) =>
            block.updatedAt === previous.updatedAt ? previous : block
          )
        );
      }
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        bumpReplyCount(replaceBlock(old, data.block.id, data.block), data.reply)
      );
      queryClient.setQueryData<StreamThreadResponse>(
        threadQueryKey(rootId, data.block.id),
        (old) => upsertThreadReply(old, data.reply)
      );
    },
  });
  return useWithMintedId(mutation);
}

export type StreamSubmitInput = StreamSubmitRequest & { blockId: string };

/** Submit a form block; the block's state shows the values read-only. */
export function useSubmitForm(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  const mutation = useMutation<
    StreamAnswerResponse,
    Error,
    StreamSubmitInput & { id: string },
    { previous: Block | null }
  >({
    mutationFn: async ({ id, blockId, values }) =>
      api<StreamAnswerResponse>(`${blockPath(rootId, blockId)}/submit`, {
        method: "POST",
        body: JSON.stringify({ id, values } satisfies StreamSubmitRequest),
      }),
    onMutate: async ({ id, blockId, values }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      let previous: Block | null = null;
      const now = new Date().toISOString();
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, blockId, (block) => {
          if (block.kind !== "form") return block;
          previous = block;
          return {
            ...block,
            state: {
              ...block.state,
              submission: {
                values,
                by: { kind: "user" },
                blockId: id,
                at: now,
              },
            },
          };
        })
      );
      return { previous };
    },
    onError: (_err, { blockId }, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<FeedCache>(key, (old) =>
          mapBlock(old, blockId, (block) =>
            block.updatedAt === previous.updatedAt ? previous : block
          )
        );
      }
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        bumpReplyCount(replaceBlock(old, data.block.id, data.block), data.reply)
      );
      queryClient.setQueryData<StreamThreadResponse>(
        threadQueryKey(rootId, data.block.id),
        (old) => upsertThreadReply(old, data.reply)
      );
    },
  });
  return useWithMintedId(mutation);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A state patch merged into a block's state the way the server does it: one
 * level deep, so `{ findings: { f1: {...} } }` changes one finding and keeps
 * the others; anything else replaces the key.
 */
export function mergeBlockState(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    const existing = next[k];
    next[k] =
      isPlainObject(existing) && isPlainObject(v) ? { ...existing, ...v } : v;
  }
  return next;
}

export type StreamStateInput = StreamStateRequest & { blockId: string };

/**
 * What a cached block should show for a state patch before the server
 * answers. A finding's patch (`{ status: "fixed" }`) replaces its record,
 * which the server stamps with who and when; the optimistic copy is given
 * the same shape. Anything else merges.
 */
export function optimisticState(
  block: Block,
  patch: Record<string, unknown>,
  now: string = new Date().toISOString()
): Block {
  const cancellation = patch.cancellation;
  let stampedPatch = patch;
  if (cancellation !== undefined) {
    const reason =
      typeof cancellation === "string"
        ? cancellation.trim()
        : isPlainObject(cancellation) && typeof cancellation.reason === "string"
          ? cancellation.reason.trim()
          : "";
    stampedPatch = {
      ...patch,
      cancellation: {
        by: { kind: "user" },
        at: now,
        ...(reason ? { reason } : {}),
      },
    };
  }
  if (block.kind !== "finding") {
    return {
      ...block,
      state: mergeBlockState(
        block.state as Record<string, unknown> | null,
        stampedPatch
      ),
    } as Block;
  }
  const word = patch.status;
  const status = word === "open" ? "open" : "resolved";
  const resolution =
    word === "dismissed"
      ? "dismissed"
      : word === "fixed"
        ? "fixed"
        : word === "resolved"
          ? ((patch.resolution as "fixed" | "dismissed" | undefined) ?? "fixed")
          : undefined;
  const note =
    typeof patch.note === "string" && patch.note.trim()
      ? patch.note.trim()
      : undefined;
  return {
    ...block,
    state: {
      status,
      ...(resolution ? { resolution } : {}),
      ...(note ? { note } : {}),
      by: { kind: "user" },
      at: now,
    },
  };
}

/**
 * A top-level block's newest version into the thread cache that hangs off
 * it, when that thread is loaded: the panel shows the root block too, and
 * a finding resolved from either place must read the same in both.
 */
export function replaceThreadRoot(
  thread: StreamThreadResponse | undefined,
  block: Block
): StreamThreadResponse | undefined {
  if (!thread || thread.root.id !== block.id) return thread;
  return { ...thread, root: block };
}

/**
 * `PATCH …/state`: resolve, dispute or reopen a finding. The patch
 * applies to the cached block at once; the response, and then the
 * `stream.entry`, carry the server's merge.
 */
/**
 * Send a post the agent never took to it again. The block already in the
 * stream is the one that goes: its row returns to pending here so the state
 * changes the moment the button is pressed, and the server's answer (or the
 * delivery event that follows it) settles it.
 */
export function useRetryDelivery(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);
  return useMutation<{ block: Block; held: boolean }, Error, string>({
    mutationFn: async (blockId) =>
      api<{ block: Block; held: boolean }>(
        `${blockPath(rootId, blockId)}/retry`,
        { method: "POST" }
      ),
    onMutate: async (blockId) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, blockId, (block) => ({
          ...block,
          delivered: null,
          // Only the recipients being sent to again go back to pending; an
          // agent that already read the post keeps its state.
          ...(block.delivery
            ? {
                delivery: block.delivery.map((entry) =>
                  entry.state === "failed"
                    ? { ...entry, state: "pending" as const }
                    : entry
                ),
              }
            : {}),
        }))
      );
    },
    // A refused retry (the agent is not running) puts the row back as it
    // was, with the reason surfaced by the caller.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        replaceBlock(old, data.block.id, data.block)
      );
      mapThreads(queryClient, rootId, (thread) =>
        mapThreadBlock(thread, data.block.id, () => data.block)
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [...STREAM_QUERY_PREFIX, rootId, "thread"],
      });
    },
  });
}

/**
 * Run a failed turn again. The turn's entry says "retried" the moment the
 * button is pressed; the new turn arrives on the stream like any other.
 */
export function useRetryTurn(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: async (blockId) =>
      api<{ ok: true }>(`${blockPath(rootId, blockId)}/retry-turn`, {
        method: "POST",
      }),
    onMutate: async (blockId) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, blockId, (block) =>
          block.turn
            ? { ...block, turn: { ...block.turn, retry: "retried" as const } }
            : block
        )
      );
    },
    // A refused retry (the agent stopped, or moved on) puts the entry back
    // as the server has it, with the reason surfaced by the caller.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

export function useSetBlockState(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  return useMutation<
    { block: Block },
    Error,
    StreamStateInput,
    { previous: Block | null }
  >({
    mutationFn: async ({ blockId, state }) =>
      api<{ block: Block }>(`${blockPath(rootId, blockId)}/state`, {
        method: "PATCH",
        body: JSON.stringify({ state } satisfies StreamStateRequest),
      }),
    onMutate: async ({ blockId, state }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      let previous: Block | null = null;
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, blockId, (block) => {
          previous = block;
          return optimisticState(block, state);
        })
      );
      // The block may be the root of an open thread, or shown by one (a
      // finding on its review's page, a review on a launch card's).
      mapThreads(queryClient, rootId, (thread) =>
        mapThreadBlock(thread, blockId, (block) =>
          optimisticState(block, state)
        )
      );
      return { previous };
    },
    onError: (_err, { blockId }, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<FeedCache>(key, (old) =>
          mapBlock(old, blockId, (block) =>
            block.updatedAt === previous.updatedAt ? previous : block
          )
        );
      }
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
      void queryClient.invalidateQueries({
        queryKey: [...STREAM_QUERY_PREFIX, rootId, "thread"],
      });
    },
    onSuccess: (data) => {
      if (!data?.block) return;
      const stored = data.block;
      // The state route returns the stored block without feed projections.
      // A thread note may have arrived over SSE while this request was in
      // flight, so keep its reply count and faces when applying the response.
      const keep = (previous: Block): Block =>
        ({
          ...stored,
          blocks: stored.blocks ?? previous.blocks,
          replyCount: stored.replyCount ?? previous.replyCount,
          lastReplyAt: stored.lastReplyAt ?? previous.lastReplyAt,
          repliers: stored.repliers ?? previous.repliers,
          unreadReplies: stored.unreadReplies ?? previous.unreadReplies,
        }) as Block;
      queryClient.setQueryData<FeedCache>(key, (old) =>
        mapBlock(old, stored.id, keep)
      );
      mapThreads(queryClient, rootId, (thread) =>
        mapThreadBlock(thread, stored.id, keep)
      );
    },
  });
}

/** Every loaded thread of this stream, through `map`. */
function mapThreads(
  queryClient: QueryClient,
  rootId: string | null,
  map: (thread: StreamThreadResponse) => StreamThreadResponse
): void {
  queryClient.setQueriesData<StreamThreadResponse>(
    { queryKey: [...STREAM_QUERY_PREFIX, rootId, "thread"] },
    (old) => (old ? map(old) : old)
  );
}

/** A thread with one block changed, wherever in it the block is. */
function mapThreadBlock(
  thread: StreamThreadResponse,
  blockId: string,
  map: (block: Block) => Block
): StreamThreadResponse {
  const root = mapShownBlock(thread.root, blockId, map);
  let changed = root !== thread.root;
  const replies = thread.replies.map((reply) => {
    const next = mapShownBlock(reply, blockId, map);
    if (next !== reply) changed = true;
    return next;
  });
  return changed ? { ...thread, root, replies } : thread;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Rewrite one block's reactions wherever it sits. An empty list drops the
 * key, as the server's feed row does, so a later `stream.entry` for the
 * same row compares equal. Everything else keeps its identity.
 */
export function updateBlockReactions(
  cache: FeedCache | undefined,
  blockId: string,
  update: (reactions: BlockReaction[]) => BlockReaction[]
): FeedCache | undefined {
  return mapBlock(cache, blockId, (block) => {
    const current = block.reactions ?? [];
    const next = update(current);
    if (next === current) return block;
    const { reactions: _reactions, ...rest } = block;
    return (next.length > 0 ? { ...rest, reactions: next } : rest) as Block;
  });
}

/** Stands in for a reaction until the server names it. */
const OPTIMISTIC_REACTION_PREFIX = "optimistic:";

/**
 * Whether a reaction is still the placeholder for an add in flight — the
 * server has not stored it yet, so there is nothing to take back off.
 */
export function isOptimisticReaction(reaction: BlockReaction): boolean {
  return reaction.id.startsWith(OPTIMISTIC_REACTION_PREFIX);
}

export type StreamReactionInput = {
  blockId: string;
  emoji: string;
  /** True to take the reaction back off, false to add it. */
  remove: boolean;
};

/**
 * Add or remove one of the user's emoji reactions on an agent's block. The
 * chip changes at once; the stored row, and its delivery outcome, arrive as
 * the block's `stream.entry`. The response only settles the one emoji this
 * call touched, so it can never undo a newer reaction the stream already
 * put in place.
 */
export function useToggleReaction(rootId: string | null) {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  return useMutation<StreamReactionResponse, Error, StreamReactionInput>({
    mutationFn: async ({ blockId, emoji, remove }) => {
      const base = `${blockPath(rootId, blockId)}/reactions`;
      return remove
        ? api<StreamReactionResponse>(`${base}/${encodeURIComponent(emoji)}`, {
            method: "DELETE",
          })
        : api<StreamReactionResponse>(base, {
            method: "POST",
            body: JSON.stringify({ emoji } satisfies StreamReactionRequest),
          });
    },
    onMutate: async ({ blockId, emoji, remove }) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<FeedCache>(key, (old) =>
        updateBlockReactions(old, blockId, (reactions) => {
          const mine = (r: BlockReaction) =>
            r.author.kind === "user" && r.emoji === emoji;
          const has = reactions.some(mine);
          if (remove) {
            return has ? reactions.filter((r) => !mine(r)) : reactions;
          }
          if (has) return reactions;
          return [
            ...reactions,
            {
              id: `${OPTIMISTIC_REACTION_PREFIX}${emoji}`,
              author: { kind: "user" },
              emoji,
              delivered: null,
              createdAt: new Date().toISOString(),
            },
          ];
        })
      );
    },
    onSuccess: (data, { emoji, remove }) => {
      if (remove) return;
      const mine = (r: BlockReaction) =>
        r.author.kind === "user" && r.emoji === emoji;
      const stored = data.reactions.find(mine);
      queryClient.setQueryData<FeedCache>(key, (old) =>
        updateBlockReactions(old, data.blockId, (reactions) => {
          const index = reactions.findIndex(mine);
          const current = index === -1 ? undefined : reactions[index];
          // Only the placeholder is ours to replace: a stored reaction here
          // came over the stream and is at least as new as this response.
          if (!stored || !current || !isOptimisticReaction(current)) {
            return reactions;
          }
          const next = reactions.slice();
          next[index] = stored;
          return next;
        })
      );
    },
    // Whatever the failure left behind, the server's copy settles it.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * `POST …/blocks/:id/read`: the person saw a thread, or one finding's
 * discussion in it. The agent replies it names are marked read in the
 * thread cache, which is what the review card's unread marks read from.
 */
export function useMarkThreadRead(rootId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<StreamThreadReadResponse, Error, { blockId: string }>({
    mutationFn: async ({ blockId }) =>
      api<StreamThreadReadResponse>(`${blockPath(rootId, blockId)}/read`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (data, { blockId }) => {
      if (data.ids.length === 0 || !data.readAt) return;
      const ids = new Set(data.ids);
      // The block the thread opens on counts its unseen replies wherever
      // it is drawn (a finding on its review, on a launch card): nothing
      // is unseen now.
      const seen = (block: Block): Block =>
        (block.unreadReplies ?? 0) > 0 ? { ...block, unreadReplies: 0 } : block;
      queryClient.setQueryData<FeedCache>(streamFeedQueryKey(rootId), (old) =>
        mapBlock(old, blockId, seen)
      );
      mapThreads(queryClient, rootId, (thread) =>
        mapThreadBlock(thread, blockId, seen)
      );
      queryClient.setQueryData<StreamThreadResponse>(
        threadQueryKey(rootId, blockId),
        (old) =>
          old
            ? {
                ...old,
                replies: old.replies.map((reply) =>
                  ids.has(reply.id) && reply.readAt === null
                    ? { ...reply, readAt: data.readAt }
                    : reply
                ),
              }
            : old
      );
    },
  });
}

/** How long a failed mark-read waits before the same mark may go again. */
export const MARK_READ_RETRY_MS = 5_000;

/**
 * Marks the agent's blocks read up to `upTo` (or all of them). The returned
 * callback is a no-op while nothing is unread, so callers can fire it from
 * visibility effects without guarding first.
 */
export function useMarkStreamRead(
  rootId: string | null,
  unreadCount: number
): (upTo?: string) => void {
  const queryClient = useQueryClient();
  const key = streamFeedQueryKey(rootId);

  const { mutate, isPending } = useMutation<
    { unreadCount: number },
    Error,
    string | undefined
  >({
    mutationFn: async (upTo) =>
      api<{ unreadCount: number }>(`${streamPath(rootId)}/read`, {
        method: "POST",
        body: JSON.stringify(upTo ? { upTo } : {}),
      }),
    // The count is all that moved; the server's `stream.read` says the same
    // to every other tab. Nothing on screen needs a refetch.
    onSuccess: (data) => {
      queryClient.setQueryData<FeedCache>(key, (old) =>
        applyStreamRead(old, data.unreadCount)
      );
    },
  });

  // The same mark at the same count would change nothing: the rows still
  // unread are ones `upTo` does not reach (a turn answering in a thread,
  // newer than the stream's last top-level post). Sending it anyway re-armed
  // every caller's effect on success, and the pane marked read in a loop,
  // dozens of times a second, each one a `stream.read` to every tab. A mark
  // that failed may go again, but not before a pause, or a server that keeps
  // failing would be asked just as often.
  const lastMark = useRef<{ key: string; failedAt: number | null } | null>(
    null
  );

  return useCallback(
    (upTo?: string) => {
      if (!rootId || unreadCount === 0 || isPending) return;
      const key = `${rootId}\n${upTo ?? ""}\n${unreadCount}`;
      const last = lastMark.current;
      if (
        last?.key === key &&
        (last.failedAt === null ||
          Date.now() - last.failedAt < MARK_READ_RETRY_MS)
      ) {
        return;
      }
      const mark = { key, failedAt: null as number | null };
      lastMark.current = mark;
      mutate(upTo, {
        onError: () => {
          mark.failedAt = Date.now();
        },
      });
    },
    [rootId, unreadCount, isPending, mutate]
  );
}
