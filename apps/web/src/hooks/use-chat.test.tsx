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
  chatFeedQueryKey,
  type FeedCache,
  shareFeedByEntryId,
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
