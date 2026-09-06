// @vitest-environment jsdom
import type {
  ChatAnswerResponse,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMessage,
} from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

import {
  appendToNewestPage,
  applyChatRead,
  chatFeedQueryKey,
  type FeedCache,
  replaceMessage,
  shareFeedByEntryId,
  shareFeedCache,
  upsertFeedEntry,
  useAnswerChatQuestion,
  useChatFeed,
} from "./use-chat";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
});

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    agentId: "agt_1",
    authorKind: "agent",
    kind: "reply",
    text: "hi",
    replyTo: null,
    question: null,
    answer: null,
    attachments: [],
    delivered: null,
    readAt: null,
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function chat(m: ChatMessage): ChatFeedEntry {
  return { type: "chat", id: m.id, at: m.createdAt, message: m };
}

function seededClient(entries: ChatFeedEntry[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<FeedCache>(chatFeedQueryKey("agt_1"), {
    pageParams: [undefined],
    pages: [{ entries, hasMore: false, unreadCount: 0, nextCursor: null }],
  });
  return client;
}

function feedMessages(client: QueryClient): ChatMessage[] {
  const cache = client.getQueryData<FeedCache>(chatFeedQueryKey("agt_1"));
  return (cache?.pages[0]?.entries ?? []).flatMap((entry) =>
    entry.type === "chat" ? [entry.message] : []
  );
}

describe("useAnswerChatQuestion", () => {
  it("posts attachments with the answer and marks the question answered on success", async () => {
    const question = message({
      id: "q1",
      kind: "question",
      text: "Which spec?",
      question: { options: [{ label: "main" }], allowFreeform: true },
    });
    const client = seededClient([chat(question)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const reply = message({
      id: "r1",
      authorKind: "user",
      text: "this one",
      replyTo: "q1",
      attachments: [{ type: "link", url: "https://example.com/spec" }],
    });
    const answered: ChatMessage = {
      ...question,
      answer: {
        value: "this one",
        replyMessageId: "r1",
        answeredAt: "2026-09-02T10:01:00.000Z",
      },
    };
    apiMock.mockResolvedValue({
      question: answered,
      reply,
      delivered: null,
    } satisfies ChatAnswerResponse);

    const { result } = renderHook(() => useAnswerChatQuestion("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        messageId: "q1",
        value: "this one",
        attachments: [{ type: "link", url: "https://example.com/spec" }],
      });
    });

    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/agents/agt_1/chat/messages/q1/answer",
      {
        method: "POST",
        body: JSON.stringify({
          value: "this one",
          attachments: [{ type: "link", url: "https://example.com/spec" }],
        }),
      }
    );
    const messages = feedMessages(client);
    expect(messages.map((m) => m.id)).toEqual(["q1", "r1"]);
    expect(messages[0]!.answer).toEqual(answered.answer);
    expect(messages[1]!.attachments).toEqual(reply.attachments);
  });

  it("leaves attachments out of the body when there are none", async () => {
    const client = seededClient([]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockResolvedValue({
      question: message({ id: "q1", kind: "question" }),
      reply: message({ id: "r1", authorKind: "user" }),
      delivered: null,
    } satisfies ChatAnswerResponse);
    const { result } = renderHook(() => useAnswerChatQuestion("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        messageId: "q1",
        value: "main",
        label: "main",
        attachments: [],
      });
    });
    expect(apiMock.mock.calls[0]![1].body).toBe(
      JSON.stringify({ value: "main", label: "main" })
    );
  });
});

describe("shareFeedByEntryId", () => {
  function page(
    entries: ChatFeedEntry[],
    extra: Partial<ChatFeedResponse> = {}
  ): ChatFeedResponse {
    return {
      entries,
      hasMore: true,
      unreadCount: 0,
      nextCursor: "c",
      ...extra,
    };
  }
  const share = shareFeedByEntryId;

  it("keeps unchanged entries when a new entry shifts every page boundary", () => {
    const m = (i: number) =>
      chat(
        message({
          id: `m${i}`,
          createdAt: `2026-09-02T10:${String(i).padStart(2, "0")}:00.000Z`,
        })
      );
    // Two pages of two, newest page first; the refetch adds m5 and the
    // oldest entry of each page slides into the next one.
    const prev: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([m(3), m(4)]), page([m(1), m(2)], { nextCursor: null })],
    };
    const next: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([m(4), m(5)]), page([m(2), m(3)], { nextCursor: null })],
    };
    const shared = share(prev, next);
    const byId = (cache: FeedCache) =>
      new Map(cache.pages.flatMap((p) => p.entries.map((e) => [e.id, e])));
    const before = byId(prev);
    const after = byId(shared);
    for (const id of ["m2", "m3", "m4"]) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(after.get("m5")).toBe(next.pages[0]!.entries[1]);
    expect(after.has("m1")).toBe(false);
    // Both pages changed content, so both are fresh objects.
    expect(shared.pages[0]).not.toBe(prev.pages[0]);
    expect(shared.pages[1]).not.toBe(prev.pages[1]);
  });

  it("returns the previous cache untouched when nothing changed", () => {
    const a = chat(message({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([chat(message({ id: "a" }))])],
    };
    expect(share(prev, next)).toBe(prev);
  });

  it("replaces only the entry that changed and keeps the other page", () => {
    const a = chat(message({ id: "a" }));
    const b = chat(message({ id: "b", createdAt: "2026-09-02T09:00:00.000Z" }));
    const prev: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([a]), page([b], { nextCursor: null })],
    };
    const edited = chat(
      message({
        id: "a",
        text: "edited",
        updatedAt: "2026-09-02T11:00:00.000Z",
      })
    );
    const next: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        page([edited]),
        page(
          [chat(message({ id: "b", createdAt: "2026-09-02T09:00:00.000Z" }))],
          { nextCursor: null }
        ),
      ],
    };
    const shared = share(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.pages[0]!.entries[0]).not.toBe(a);
    expect(
      shared.pages[0]!.entries[0]!.type === "chat" &&
        shared.pages[0]!.entries[0]!.message.text
    ).toBe("edited");
    expect(shared.pages[1]).toBe(prev.pages[1]);
  });

  it("tracks page metadata such as the unread count", () => {
    const a = chat(message({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([chat(message({ id: "a" }))], { unreadCount: 2 })],
    };
    const shared = share(prev, next);
    expect(shared.pages[0]!.unreadCount).toBe(2);
    expect(shared.pages[0]!.entries).toBe(prev.pages[0]!.entries);
  });

  it("notices any page field changing, not only the ones it knows about", () => {
    const a = chat(message({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const withExtra = (value: string): ChatFeedResponse =>
      ({
        ...page([chat(message({ id: "a" }))]),
        extra: value,
      }) as ChatFeedResponse;
    const shared = share(
      share(prev, { ...prev, pages: [withExtra("one")] }) as FeedCache,
      {
        pageParams: [undefined],
        pages: [withExtra("two")],
      }
    );
    expect((shared.pages[0] as unknown as { extra: string }).extra).toBe("two");
    expect(shared.pages[0]!.entries).toBe(prev.pages[0]!.entries);
  });

  // setQueryData applies structuralSharing too, so the optimistic paths in
  // this module pass through the function; each shape must come out right.
  it("keeps an optimistic append and reuses every other entry", () => {
    const a = chat(message({ id: "a" }));
    const b = chat(message({ id: "b" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a, b])] };
    const optimistic = message({ id: "optimistic-1", text: "sending" });
    const shared = share(prev, appendToNewestPage(prev, optimistic)!);
    expect(shared.pages[0]!.entries.map((e) => e.id)).toEqual([
      "a",
      "b",
      "optimistic-1",
    ]);
    expect(shared.pages[0]!.entries[0]).toBe(a);
    expect(shared.pages[0]!.entries[1]).toBe(b);
    expect(
      shared.pages[0]!.entries[2]!.type === "chat" &&
        shared.pages[0]!.entries[2]!.message.text
    ).toBe("sending");
  });

  it("replaces an answered question in place and reuses the rest", () => {
    const qm = message({
      id: "q",
      kind: "question",
      question: { options: [{ label: "Yes" }] },
    });
    const q = chat(qm);
    const other = chat(message({ id: "o" }));
    const prev: FeedCache = {
      pageParams: [undefined],
      pages: [page([q, other])],
    };
    const answered = {
      ...qm,
      answer: {
        value: "Yes",
        label: "Yes",
        replyMessageId: "r",
        answeredAt: "2026-09-02T10:05:00.000Z",
      },
    };
    const shared = share(prev, replaceMessage(prev, "q", answered)!);
    const first = shared.pages[0]!.entries[0]!;
    const second = shared.pages[0]!.entries[1];
    expect(first).not.toBe(q);
    expect(first.type === "chat" ? first.message.answer?.value : null).toBe(
      "Yes"
    );
    expect(second).toBe(other);
  });

  it("applies the unread patch while keeping the entries array", () => {
    const a = chat(message({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const patched = share(prev, {
      ...prev,
      pages: [{ ...prev.pages[0]!, unreadCount: 3 }],
    });
    expect(patched.pages[0]!.unreadCount).toBe(3);
    expect(patched.pages[0]!.entries).toBe(prev.pages[0]!.entries);
    expect(patched.pages[0]).not.toBe(prev.pages[0]);
  });

  it("falls back to deep sharing when either side is not a feed cache", () => {
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([chat(message({ id: "a" }))])],
    };
    // First fetch: nothing to share with yet.
    expect(shareFeedCache(undefined, next)).toBe(next);
    // Not a cache at all: plain deep sharing, never the by-id path.
    const prevPlain = { pages: "nope" };
    expect(shareFeedCache(prevPlain, { pages: "nope" })).toBe(prevPlain);
  });

  it("shares by id through the query's structuralSharing option", async () => {
    const m = (i: number) =>
      chat(
        message({
          id: `m${i}`,
          createdAt: `2026-09-02T10:${String(i).padStart(2, "0")}:00.000Z`,
        })
      );
    apiMock.mockResolvedValueOnce(page([m(1), m(2)], { nextCursor: null }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useChatFeed("agt_1"), { wrapper });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    const before = result.current.entries;
    apiMock.mockResolvedValueOnce(page([m(2), m(3)], { nextCursor: null }));
    await act(async () => {
      await client.refetchQueries({ queryKey: chatFeedQueryKey("agt_1") });
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries[0]).toBe(before[1]);
  });
});

describe("upsertFeedEntry", () => {
  const page = (
    entries: ChatFeedEntry[],
    extra: Partial<ChatFeedResponse> = {}
  ): ChatFeedResponse => ({
    entries,
    hasMore: false,
    unreadCount: 0,
    nextCursor: null,
    ...extra,
  });
  const at = (s: number) =>
    `2026-09-02T10:00:${String(s).padStart(2, "0")}.000Z`;
  const status = (id: string, when: string): ChatFeedEntry => ({
    type: "status",
    id,
    eventType: "working",
    message: id,
    at: when,
  });

  it("appends a newer entry to the newest page and bumps unread for agent posts", () => {
    const a = chat(message({ id: "a", createdAt: at(1) }));
    const cache: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const fresh = chat(message({ id: "b", createdAt: at(2), readAt: null }));
    const result = upsertFeedEntry(cache, fresh);
    expect(result.placed).toBe(true);
    expect(result.cache.pages[0]!.entries).toEqual([a, fresh]);
    expect(result.cache.pages[0]!.entries[0]).toBe(a);
    expect(result.cache.pages[0]!.unreadCount).toBe(1);
    // A user's own post is never unread.
    const own = chat(
      message({ id: "c", authorKind: "user", createdAt: at(3) })
    );
    expect(upsertFeedEntry(result.cache, own).cache.pages[0]!.unreadCount).toBe(
      1
    );
  });

  it("slots an entry in by time when it is not the newest", () => {
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [page([status("event:1", at(1)), status("event:3", at(3))])],
    };
    const result = upsertFeedEntry(cache, status("event:2", at(2)));
    expect(result.cache.pages[0]!.entries.map((e) => e.id)).toEqual([
      "event:1",
      "event:2",
      "event:3",
    ]);
  });

  it("replaces a known entry in place, keeping identity when nothing changed", () => {
    const q = chat(message({ id: "q", kind: "question", readAt: null }));
    const other = status("event:9", at(5));
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [page([q, other], { unreadCount: 1 })],
    };
    const same = upsertFeedEntry(
      cache,
      chat(message({ id: "q", kind: "question", readAt: null }))
    );
    expect(same.cache).toBe(cache);
    const read = chat(message({ id: "q", kind: "question", readAt: at(9) }));
    const result = upsertFeedEntry(cache, read);
    expect(result.placed).toBe(true);
    expect(result.cache.pages[0]!.entries[0]).not.toBe(q);
    expect(result.cache.pages[0]!.entries[1]).toBe(other);
    // Marked read on the way: the count follows.
    expect(result.cache.pages[0]!.unreadCount).toBe(0);
  });

  it("puts the count on the newest page even when the row is on an older one", () => {
    const old = chat(message({ id: "o", createdAt: at(1), readAt: null }));
    const cache: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        page([status("event:5", at(5))], {
          unreadCount: 1,
          hasMore: true,
          nextCursor: "c1",
        }),
        page([old]),
      ],
    };
    const result = upsertFeedEntry(
      cache,
      chat(message({ id: "o", createdAt: at(1), readAt: at(6) }))
    );
    expect(
      result.cache.pages[1]!.entries[0]!.type === "chat" &&
        result.cache.pages[1]!.entries[0]!.message.readAt
    ).toBe(at(6));
    expect(result.cache.pages[0]!.unreadCount).toBe(0);
    expect(result.cache.pages[0]!.entries).toBe(cache.pages[0]!.entries);
  });

  it("refuses an entry older than a head that has pages below it", () => {
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        page([status("event:5", at(5))], { hasMore: true, nextCursor: "c1" }),
      ],
    };
    const result = upsertFeedEntry(cache, status("event:1", at(1)));
    expect(result.placed).toBe(false);
    expect(result.cache).toBe(cache);
    // With the whole history loaded it is simply the oldest row.
    const complete: FeedCache = {
      pageParams: [undefined],
      pages: [page([status("event:5", at(5))])],
    };
    expect(
      upsertFeedEntry(
        complete,
        status("event:1", at(1))
      ).cache.pages[0]!.entries.map((e) => e.id)
    ).toEqual(["event:1", "event:5"]);
  });

  it("has nowhere to put anything in an empty cache", () => {
    expect(
      upsertFeedEntry({ pageParams: [], pages: [] }, status("event:1", at(1)))
        .placed
    ).toBe(false);
  });
});

describe("applyChatRead", () => {
  it("moves only the count, and only when it moved", () => {
    const a = chat(message({ id: "a" }));
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        { entries: [a], hasMore: false, nextCursor: null, unreadCount: 2 },
      ],
    };
    expect(applyChatRead(cache, 2)).toBe(cache);
    const next = applyChatRead(cache, 0)!;
    expect(next.pages[0]!.unreadCount).toBe(0);
    expect(next.pages[0]!.entries).toBe(cache.pages[0]!.entries);
    expect(applyChatRead(undefined, 0)).toBeUndefined();
  });
});

describe("replaceMessage", () => {
  it("drops the placeholder when the real row already arrived over the stream", () => {
    const temp = chat(
      message({ id: "optimistic-1", authorKind: "user", text: "hi" })
    );
    const real = message({ id: "real", authorKind: "user", text: "hi" });
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        {
          entries: [temp, chat(real)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
        },
      ],
    };
    const next = replaceMessage(cache, "optimistic-1", real)!;
    expect(next.pages[0]!.entries.map((e) => e.id)).toEqual(["real"]);
    expect(next.pages[0]!.entries[0]).toBe(cache.pages[0]!.entries[1]);
  });
});
