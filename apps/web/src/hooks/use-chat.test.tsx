// @vitest-environment jsdom
import type {
  ChatAnswerResponse,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMessage,
} from "@dispatch/shared";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { chatFeedQueryKey, useAnswerChatQuestion } from "./use-chat";

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

type FeedCache = InfiniteData<ChatFeedResponse, string | undefined>;

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
