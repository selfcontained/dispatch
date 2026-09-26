// @vitest-environment jsdom
vi.mock(
  "@/components/app/chat/composer-input",
  () => import("@/test-utils/composer-input")
);
import type { ReactNode } from "react";
import type { Block, StreamThreadResponse } from "@dispatch/shared";
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
import {
  block,
  findingBlock,
  findingRecord,
  launchBlock,
  questionBody,
  reviewBlock,
  turnBlock,
} from "@/test-utils/blocks";

import {
  groupReplies,
  ThreadPanel,
  threadTitle,
  withThreadNames,
} from "./thread-panel";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  api: (url: string, ...args: unknown[]) =>
    url.endsWith("/permissions")
      ? Promise.resolve({ connected: false, requests: [] })
      : apiMock(url, ...args),
}));
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
  onOpenFile: vi.fn(),
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

  const naming = () =>
    findingBlock(
      "f1",
      { severity: "minor", title: "Naming", body: "Rename x." },
      { reviewId: "rv", author: { kind: "agent", agentId: "agt_2" } }
    );
  const spacing = (overrides: Parameters<typeof findingBlock>[2] = {}) =>
    findingBlock(
      "f2",
      { severity: "nit", title: "Spacing", body: "Add a gap." },
      {
        reviewId: "rv",
        author: { kind: "agent", agentId: "agt_2" },
        replyCount: 1,
        ...overrides,
      }
    );
  const reviewWith = () =>
    reviewBlock({
      id: "rv",
      author: { kind: "agent", agentId: "agt_2" },
      summary: "Looks fine.",
      findings: [naming(), spacing()],
    });
  const peerCtx: FeedContext = {
    ...ctx,
    peers: {
      agt_2: { name: "Reviewer", agentType: "codex", relation: "child" },
    },
  };

  it("becomes the named finding's own panel: its detail, its comments, its composer", async () => {
    client.setQueryData(threadQueryKey("agt_1", "rv"), {
      root: reviewWith(),
      replies: [],
    });
    // The finding's discussion is its own thread, rooted at the finding.
    client.setQueryData(threadQueryKey("agt_1", "f2"), {
      root: spacing(),
      replies: [
        block({
          id: "c1",
          text: "on f2",
          threadId: "f2",
          replyTo: "f2",
          author: { kind: "agent", agentId: "agt_2" },
          readAt: "2026-09-02T10:00:00.000Z",
        }),
      ],
    });
    const onSetBlockState = vi.fn();
    const onOpenThread = vi.fn();
    renderPanel({
      blockId: "rv",
      findingId: "f2",
      ctx: { ...peerCtx, onSetBlockState, onOpenThread },
    });
    expect(
      screen.getByTestId("chat-thread-panel").getAttribute("data-finding-id")
    ).toBe("f2");
    const subject = screen.getByTestId("chat-thread-subject");
    expect(subject.textContent).toContain("in the review by Reviewer");
    // Back to the review's page.
    fireEvent.click(subject);
    expect(onOpenThread).toHaveBeenCalledWith("rv");
    const detail = screen.getByTestId("chat-finding-detail");
    expect(detail.textContent).toContain("Spacing");
    expect(detail.textContent).toContain("Add a gap.");
    // The finding in full, not the review's rows.
    expect(screen.queryByTestId("chat-review-finding")).toBeNull();
    expect(screen.queryByTestId("chat-review-block")).toBeNull();
    const replies = screen.getByTestId("chat-thread-replies");
    expect(replies.textContent).toContain("on f2");
    expect(screen.getByTestId("chat-thread-count").textContent).toBe(
      "1 comment"
    );
    // Its controls change the finding block itself.
    fireEvent.click(screen.getByTestId("chat-review-resolve"));
    expect(onSetBlockState).toHaveBeenCalledWith("f2", { status: "fixed" });

    // The composer replies to the finding: its own thread.
    apiMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: string };
      return {
        block: block({
          id,
          authorKind: "user",
          toAgentId: "agt_2",
          text: "why?",
          threadId: "f2",
          replyTo: "f2",
          createdAt: "2026-09-02T10:03:00.000Z",
        }),
        delivered: null,
        held: false,
      };
    });
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "why?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/streams/agt_1/blocks", {
        method: "POST",
        body: expect.stringMatching(
          /^\{"id":"[0-9a-f-]{36}","text":"why\?","replyTo":"f2"\}$/
        ),
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-thread-count").textContent).toBe(
        "2 comments"
      )
    );
    expect(
      client
        .getQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "f2"))!
        .replies.map((r) => r.text)
    ).toEqual(["on f2", "why?"]);
    // The review's page is untouched: a finding's comment is not a reply there.
    expect(
      client.getQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "rv"))!
        .replies
    ).toEqual([]);
  });

  it("says in a finding's thread who settled it and when, among the comments at that time", () => {
    client.setQueryData(threadQueryKey("agt_1", "f2"), {
      root: spacing({
        record: findingRecord("fixed", {
          by: { kind: "agent", agentId: "agt_2" },
          at: "2026-09-02T10:01:30.000Z",
          note: "Verified the gap.",
        }),
      }),
      replies: [
        block({
          id: "c1",
          text: "Added the gap.",
          threadId: "f2",
          replyTo: "f2",
          createdAt: "2026-09-02T10:01:00.000Z",
          readAt: "2026-09-02T10:01:00.000Z",
        }),
        block({
          id: "c2",
          text: "Thanks.",
          threadId: "f2",
          replyTo: "f2",
          createdAt: "2026-09-02T10:02:00.000Z",
          readAt: "2026-09-02T10:02:00.000Z",
        }),
      ],
    });
    renderPanel({ blockId: "rv", findingId: "f2", ctx: peerCtx });
    const change = screen.getByTestId("chat-finding-change");
    expect(change.getAttribute("data-outcome")).toBe("fixed");
    expect(change.textContent).toContain("Fixed by Reviewer");
    expect(change.textContent).toContain("Verified the gap.");
    // After the comment before it, ahead of the one that came later.
    const order = [
      ...screen
        .getByTestId("chat-thread-replies")
        .querySelectorAll(
          "[data-chat-entry-id], [data-testid='chat-finding-change']"
        ),
    ].map((el) => el.getAttribute("data-chat-entry-id") ?? "change");
    expect(order).toEqual(["c1", "change", "c2"]);
  });

  it("leaves a finding's thread without an entry while it stands as raised", () => {
    client.setQueryData(threadQueryKey("agt_1", "f2"), {
      root: spacing(),
      replies: [],
    });
    renderPanel({ blockId: "rv", findingId: "f2", ctx: peerCtx });
    expect(screen.queryByTestId("chat-finding-change")).toBeNull();
  });

  it("loads the finding's thread route and marks its comments read by the finding", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/f2/thread")) {
        return {
          root: spacing({ unreadReplies: 1 }),
          replies: [
            block({
              id: "c1",
              text: "fixed it",
              threadId: "f2",
              replyTo: "f2",
              author: { kind: "agent", agentId: "agt_2" },
            }),
          ],
        } satisfies StreamThreadResponse;
      }
      return { ids: ["c1"], readAt: "2026-09-02T10:05:00.000Z" };
    });
    renderPanel({ blockId: "rv", findingId: "f2", ctx: peerCtx });
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/f2/thread"
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/streams/agt_1/blocks/f2/read",
        { method: "POST", body: "{}" }
      )
    );
    // The review's own thread was never asked for.
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/rv/thread"
    );
  });

  it("opens a finding from the review's page over that page", () => {
    client.setQueryData(threadQueryKey("agt_1", "rv"), {
      root: reviewWith(),
      replies: [],
    });
    apiMock.mockResolvedValue({ root: reviewWith(), replies: [] });
    const onOpenThread = vi.fn();
    renderPanel({ blockId: "rv", ctx: { ...peerCtx, onOpenThread } });
    // The review in full: open, its findings as rows.
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(rows.map((r) => r.getAttribute("data-finding-id"))).toEqual([
      "f1",
      "f2",
    ]);
    expect(rows[1]!.textContent).toContain("1 comment");
    fireEvent.click(screen.getAllByTestId("chat-review-finding-link")[1]!);
    expect(onOpenThread).toHaveBeenCalledWith("rv", "f2");
  });

  it("draws a turn a reply opened in place of that reply, on a review's page and a finding's", () => {
    // A turn a thread reply opened answers in that thread: its block is a
    // reply in the same thread, with the turn attached.
    const turnFor = (
      id: string,
      threadId: string,
      chatMessageId: string,
      at: string
    ): Block =>
      turnBlock({
        id,
        threadId,
        replyTo: chatMessageId,
        text: `answer for ${chatMessageId}`,
        createdAt: at,
        turn: {
          prompt: {
            source: "chat",
            text: "",
            attachments: [],
            chatMessageId,
            threadId,
          },
        },
      });
    const comment = (id: string, threadId: string, text: string, at: string) =>
      block({
        id,
        authorKind: "user",
        text,
        threadId,
        replyTo: threadId,
        createdAt: at,
      });
    client.setQueryData(threadQueryKey("agt_1", "rv"), {
      root: reviewWith(),
      replies: [
        comment("c1", "rv", "overall?", "2026-09-02T10:01:00.000Z"),
        turnFor("turn:1", "rv", "c1", "2026-09-02T10:01:10.000Z"),
        comment("c2", "rv", "and?", "2026-09-02T10:02:00.000Z"),
        turnFor("turn:2", "rv", "c2", "2026-09-02T10:02:10.000Z"),
      ],
    });
    client.setQueryData(threadQueryKey("agt_1", "f2"), {
      root: spacing(),
      replies: [
        comment("c3", "f2", "please fix f2", "2026-09-02T10:03:00.000Z"),
        turnFor("turn:3", "f2", "c3", "2026-09-02T10:03:10.000Z"),
      ],
    });
    apiMock.mockResolvedValue({ ids: [], readAt: null });

    const { unmount } = renderPanel({ blockId: "rv", ctx: peerCtx });
    const turns = screen.getAllByTestId("chat-thread-turn");
    expect(turns.map((t) => t.getAttribute("data-turn-id"))).toEqual([
      "turn:1",
      "turn:2",
    ]);
    // Each turn is the agent's answer post under the reply that opened it,
    // with its step list; the reply itself keeps its own row. The findings
    // are the review's rows, not posts.
    expect(
      screen
        .getAllByTestId("chat-message")
        .map((m) => m.getAttribute("data-block-id"))
    ).toEqual(["rv", "c1", "turn:1", "c2", "turn:2"]);
    const answer = turns[0]!.querySelector('[data-testid="chat-message"]')!;
    expect(answer.getAttribute("data-origin")).toBe("turn");
    expect(answer.textContent).toContain("answer for c1");
    expect(
      answer
        .querySelector('[data-testid="chat-turn"]')
        ?.getAttribute("data-turn-id")
    ).toBe("turn:1");
    expect(screen.getByTestId("chat-thread-count").textContent).toBe(
      "4 replies"
    );
    unmount();

    // A finding's page is the finding's own thread, turns and all.
    renderPanel({ blockId: "rv", findingId: "f2", ctx: peerCtx });
    expect(
      screen
        .getAllByTestId("chat-message")
        .map((m) => m.getAttribute("data-block-id"))
    ).toEqual(["f2", "c3", "turn:3"]);
    expect(
      screen
        .getAllByTestId("chat-thread-turn")
        .map((t) => t.getAttribute("data-turn-id"))
    ).toEqual(["turn:3"]);
    expect(screen.getByTestId("chat-thread-count").textContent).toBe(
      "2 comments"
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

describe("threadTitle", () => {
  const nameOf = (id: string) =>
    ({ agt_1: "builder", agt_2: "Reviewer", agt_3: "orchestrator" })[id] ??
    "Agent";

  it("names a finding's page after the review it is in", () => {
    const finding = findingBlock(
      "f1",
      { severity: "minor", title: "Naming", body: "" },
      { author: { kind: "agent", agentId: "agt_2" } }
    );
    expect(threadTitle(finding, true, nameOf)).toEqual({
      title: "Finding",
      subtitle: "in the review by Reviewer",
    });
    expect(threadTitle(null, true, nameOf)).toEqual({
      title: "Finding",
      subtitle: "",
    });
    const review = reviewBlock({
      author: { kind: "agent", agentId: "agt_2" },
    });
    expect(threadTitle(review, false, nameOf)).toEqual({
      title: "Review",
      subtitle: "by Reviewer",
    });
  });

  it("names a launch card's thread after the agent it launched", () => {
    expect(
      threadTitle(launchBlock({ id: "l1", toAgentId: "agt_2" }), false, nameOf)
    ).toEqual({ title: "Reviewer", subtitle: "launched by you" });
    expect(
      threadTitle(
        launchBlock({
          id: "l2",
          toAgentId: "agt_2",
          launchedByAgentId: "agt_3",
        }),
        false,
        nameOf
      )
    ).toEqual({ title: "Reviewer", subtitle: "launched by orchestrator" });
  });

  it("strips markdown marks from the subject", () => {
    const root = block({
      id: "r",
      author: { kind: "agent", agentId: "agt_1" },
      text: "**Question block.** Pick a `demo` option; see [docs](http://x).",
    });
    expect(threadTitle(root, false, () => "demo").subtitle).toBe(
      "demo: Question block. Pick a demo option; see docs."
    );
  });
});

describe("withThreadNames", () => {
  const base: FeedContext = {
    agentId: "agt_1",
    onOpenFile: () => {},
    peers: {
      agt_2: { name: "Reviewer", agentType: "codex", relation: "child" },
    },
  };

  it("adds the thread's names for agents the feed cannot name", () => {
    const ctx = withThreadNames(base, { agt_gone: "helper", agt_2: "old" });
    expect(ctx.names).toEqual({ agt_gone: "helper" });
  });

  it("keeps the feed's context when the thread adds nothing", () => {
    expect(withThreadNames(base, undefined)).toBe(base);
    expect(withThreadNames(base, { agt_2: "Reviewer" })).toBe(base);
    const named = { ...base, names: { agt_gone: "helper" } };
    expect(withThreadNames(named, { agt_gone: "helper" })).toBe(named);
  });
});

describe("ThreadPanel jump to a reply", () => {
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  it("scrolls to the `block` reply once the thread loads, and keeps it there", async () => {
    // The reply sits 600px down the panel; everything else at the top.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const top = this.dataset.chatEntryId === "r1" ? 600 : 0;
      return { top, bottom: top + 40, height: 40 } as DOMRect;
    };
    let resolve: (value: StreamThreadResponse) => void = () => {};
    apiMock.mockReturnValueOnce(
      new Promise<StreamThreadResponse>((r) => {
        resolve = r;
      })
    );
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/agents/agt_1?thread=root&block=r1"]}>
          <ThreadPanel
            agentId="agt_1"
            rootId="agt_1"
            blockId="root"
            ctx={ctx}
            disabledReason={null}
            isMobile={false}
            onClose={vi.fn()}
            onAnswer={vi.fn()}
            answeringBlockId={null}
            submittingBlockId={null}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const scroll = screen.getByTestId("chat-thread-scroll");
    expect(scroll.scrollTop).toBe(0);
    // Replies scroll through repeated controls: no backdrop blur in here.
    expect(scroll.classList.contains("stream-surfaces-flat")).toBe(true);

    // The thread arrives after the panel opened on it.
    resolve(thread);
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-chat-entry-id="r1"]')
          ?.hasAttribute("data-jump-flash")
      ).toBe(true)
    );
    // Its top edge, less the gap: the panel's open-at-the-top did not undo it.
    expect(scroll.scrollTop).toBe(592);
  });
});
