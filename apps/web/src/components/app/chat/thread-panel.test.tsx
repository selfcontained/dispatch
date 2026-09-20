// @vitest-environment jsdom
import type { ReactNode } from "react";
import type { StreamThreadResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { threadQueryKey } from "@/hooks/use-stream";
import { block, questionBody, reviewBody } from "@/test-utils/blocks";

import { groupReplies, ThreadPanel } from "./thread-panel";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => (
    <div data-testid="markdown-mock">{children}</div>
  ),
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

const ctx: FeedContext = {
  agentId: "agt_1",
  agentName: "builder",
  agentType: "claude",
  onOpenMedia: vi.fn(),
};

const root = block({
  id: "root",
  text: "Which approach?",
  body: questionBody([{ label: "A" }, { label: "B" }], {
    allowFreeform: true,
  }),
  replyCount: 2,
  lastReplyAt: "2026-09-02T10:02:00.000Z",
});

const thread: StreamThreadResponse = {
  root,
  replies: [
    block({
      id: "r1",
      authorKind: "user",
      text: "Go with A",
      threadId: "root",
      replyTo: "root",
      delivered: true,
      createdAt: "2026-09-02T10:01:00.000Z",
    }),
    block({
      id: "r2",
      text: "Doing A.",
      threadId: "root",
      replyTo: "root",
      createdAt: "2026-09-02T10:02:00.000Z",
    }),
  ],
};

let client: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderPanel(props: Partial<Parameters<typeof ThreadPanel>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <ThreadPanel
      agentId="agt_1"
      rootId="agt_1"
      blockId="root"
      ctx={ctx}
      disabledReason={null}
      isMobile={false}
      onClose={onClose}
      onAnswer={vi.fn()}
      answeringBlockId={null}
      submittingBlockId={null}
      {...props}
    />,
    { wrapper: Wrapper }
  );
  return { ...view, onClose };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  apiMock.mockReset();
  Element.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("ThreadPanel", () => {
  it("loads the thread route and shows the root with its replies, no reply line", async () => {
    apiMock.mockResolvedValueOnce(thread);
    renderPanel();
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/root/thread"
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-thread-count").textContent).toContain(
        "2 replies"
      )
    );
    const posts = screen.getAllByTestId("chat-message");
    expect(posts.map((p) => p.getAttribute("data-block-id"))).toEqual([
      "root",
      "r1",
      "r2",
    ]);
    // The root's question is still answerable from the panel.
    expect(screen.getAllByTestId("chat-question-option")).toHaveLength(2);
    // The reply line belongs to the main column only.
    expect(screen.queryByTestId("chat-thread-line")).toBeNull();
  });

  it("posts a reply under the root from its own composer", async () => {
    client.setQueryData(threadQueryKey("agt_1", "root"), thread);
    apiMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: string };
      return {
        block: block({
          id,
          authorKind: "user",
          text: "and B later",
          threadId: "root",
          replyTo: "root",
          createdAt: "2026-09-02T10:03:00.000Z",
        }),
        delivered: null,
        held: false,
      };
    });
    renderPanel();
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "and B later" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/streams/agt_1/blocks", {
        method: "POST",
        body: expect.stringMatching(
          /^\{"id":"[0-9a-f-]{36}","text":"and B later","replyTo":"root"\}$/
        ),
      })
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("chat-message")
          .map((p) => p.getAttribute("data-block-id"))
      ).toHaveLength(4)
    );
    expect(screen.getAllByTestId("chat-message")[3]!.textContent).toContain(
      "and B later"
    );
  });

  it("closes from its button and from Escape, and is a sheet on a phone", () => {
    client.setQueryData(threadQueryKey("agt_1", "root"), thread);
    const { onClose } = renderPanel({ isMobile: true });
    expect(
      screen.getByTestId("chat-thread-panel").getAttribute("data-mobile")
    ).toBe("true");
    fireEvent.click(screen.getByTestId("chat-thread-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("becomes the named finding's own panel: its detail, its comments, its composer", () => {
    const review = block({
      id: "rv",
      body: reviewBody("comment", "Looks fine.", [
        { id: "f1", severity: "minor", title: "Naming", body: "Rename x." },
        { id: "f2", severity: "nit", title: "Spacing", body: "Add a gap." },
      ]),
    });
    client.setQueryData(threadQueryKey("agt_1", "rv"), {
      root: review,
      replies: [
        block({
          id: "c1",
          text: "on f2",
          body: { kind: "text", data: { findingId: "f2" }, state: null },
        }),
        block({
          id: "c2",
          text: "on f1",
          body: { kind: "text", data: { findingId: "f1" }, state: null },
        }),
        block({ id: "c3", text: "general" }),
      ],
    });
    renderPanel({ blockId: "rv", findingId: "f2" });
    expect(screen.getByTestId("chat-thread-subject").textContent).toContain(
      "in the review by"
    );
    const detail = screen.getByTestId("chat-finding-detail");
    expect(detail.textContent).toContain("Spacing");
    expect(detail.textContent).toContain("Add a gap.");
    expect(screen.queryByTestId("chat-review-finding")).toBeNull();
    // Only this finding's comments.
    const replies = screen.getByTestId("chat-thread-replies");
    expect(replies.textContent).toContain("on f2");
    expect(replies.textContent).not.toContain("on f1");
    expect(replies.textContent).not.toContain("general");
    expect(screen.getByTestId("chat-thread-count").textContent).toBe(
      "1 comment"
    );
  });

  it("reports a failed load with a retry", async () => {
    apiMock.mockRejectedValueOnce(new Error("gone"));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("chat-thread-error").textContent).toContain(
        "gone"
      )
    );
  });
});

describe("groupReplies", () => {
  it("groups consecutive replies by the same author within five minutes", () => {
    const at = (m: string) => `2026-09-02T10:${m}:00.000Z`;
    const replies = [
      block({ id: "a", authorKind: "user", createdAt: at("00") }),
      block({ id: "b", authorKind: "user", createdAt: at("03") }),
      block({ id: "c", createdAt: at("04") }),
      block({ id: "d", createdAt: at("20") }),
    ];
    expect(groupReplies(replies, ctx)).toEqual([false, true, false, false]);
  });
});
