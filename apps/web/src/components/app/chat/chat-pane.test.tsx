// @vitest-environment jsdom
import type { ChatTurnEntry, StreamEntry } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import {
  answered,
  block,
  blockEntry,
  FILE_BODY,
  questionBody,
  turnEntry as turnRow,
} from "@/test-utils/blocks";
import { api } from "@/lib/api";

import {
  ChatPane,
  clearChatScrollMemory,
  entryOwner,
  filterStreamView,
  isMainColumnEntry,
  questionExcerpt,
  type StreamView,
  readChatScrollPosition,
  REMEMBER_THROTTLE_MS,
  rememberChatScrollPosition,
} from "./chat-pane";

// The pane's data layer is exercised elsewhere; here it is replaced so the
// pane's own decisions can be driven directly: what the composer does with a
// typed message, and what shows when the feed has no chat messages.
const H = vi.hoisted(() => ({
  entries: [] as unknown[],
  unreadCount: 0,
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
  send: vi.fn(async (_input: unknown) => ({}) as never),
  answer: vi.fn(async (_input: unknown) => ({}) as never),
  // Stable like the real `mutate`: the pane hangs memoised callbacks off it.
  answerNow: vi.fn(),
  sendNow: vi.fn(),
  markRead: vi.fn(),
  /** What the thread panel shows for whichever thread is open. */
  threadRoot: null as unknown,
  /** The agents list the peers query resolves to. */
  agents: [] as unknown[],
  /** The lineage the pane reads: the page agent's root, and what sits under it. */
  rootId: null as string | null,
  descendants: new Set<string>() as ReadonlySet<string>,
  /** Every root id the feed was asked for, in order. */
  streamIds: [] as Array<string | null>,
}));

// No real request may be in flight under a test: the pane's peers query
// (`GET /api/v1/agents`) would otherwise hit whatever answers the jsdom
// origin, and a resolved directory re-renders every post.
vi.mock("@/lib/api", () => ({
  api: vi.fn(async () => ({ agents: H.agents })),
}));

vi.mock("@/hooks/use-agent-tree", () => ({
  useRootAgentId: (agentId: string | null) => H.rootId ?? agentId,
  useDescendantAgentIds: () => H.descendants,
}));

vi.mock("@/hooks/use-stream", () => ({
  useStreamFeed: (rootId: string | null) => ({
    entries: (H.streamIds.push(rootId), H.entries),
    unreadCount: H.unreadCount,
    hasOlder: false,
    isLoading: H.isLoading,
    isFetchingOlder: false,
    error: H.error,
    loadOlder: vi.fn(),
    refetch: H.refetch,
  }),
  usePostBlock: () => ({
    mutate: H.sendNow,
    mutateAsync: H.send,
    isPending: false,
    variables: undefined,
  }),
  useMarkThreadRead: () => ({ mutate: vi.fn(), isPending: false }),
  useAnswerQuestion: () => ({
    mutate: H.answerNow,
    mutateAsync: H.answer,
    isPending: false,
    variables: undefined,
  }),
  useSubmitForm: (() => {
    const mutate = vi.fn();
    const mutateAsync = vi.fn();
    return () => ({
      mutate,
      mutateAsync,
      isPending: false,
      variables: undefined,
    });
  })(),
  useRetryDelivery: (() => {
    const mutate = vi.fn();
    return () => ({ mutate, isPending: false, variables: undefined });
  })(),
  useRetryTurn: (() => {
    const mutate = vi.fn();
    return () => ({ mutate, isPending: false, variables: undefined });
  })(),
  useSetBlockState: (() => {
    const mutate = vi.fn();
    return () => ({ mutate, isPending: false, variables: undefined });
  })(),
  useMarkStreamRead: () => H.markRead,
  useThread: () => ({
    root: H.threadRoot,
    replies: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  // One mutate for the whole file: the feed's rows are memoised on a context
  // built from it.
  useToggleReaction: (() => {
    const mutate = vi.fn();
    return () => ({ mutate });
  })(),
}));
// Counts renders of a post's markdown body: the feed's rows are memoised,
// so a pane re-render that changes nothing they show must not reach it.
const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    markdownRenders.count += 1;
    return <div data-testid="markdown-mock">{children}</div>;
  },
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

const agent: Agent = {
  id: "agt_1",
  name: "demo",
  status: "running",
  cwd: "/tmp",
  worktreePath: null,
  worktreeBranch: null,
  agentArgs: [],
  model: null,
  fullAccess: false,
  filesDir: null,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  latestEvent: {
    type: "working",
    message: "Running tests",
    updatedAt: "2026-09-02T10:00:00.000Z",
    metadata: null,
  },
};

function Wrapper({ children }: { children: ReactNode }) {
  // One client per mounted tree: a rerender must not hand the pane a fresh
  // client (and so fresh query/mutation state) that the app never would.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderPane(props: Partial<Parameters<typeof ChatPane>[0]> = {}) {
  return render(
    <ChatPane
      agentId="agt_1"
      agent={agent}
      active={true}
      showChildAgents={true}
      onShowChildAgentsChange={vi.fn()}
      openLightbox={vi.fn()}
      isMobile={false}
      {...props}
    />,
    { wrapper: Wrapper }
  );
}

/**
 * A turn run by `agentId`, settled, with a couple of steps: its answer
 * block ("answer <id>") with the turn attached. The prompt ("prompt <id>")
 * is the turn's own record; the user's block is a row of its own.
 */
function turnEntry(
  id: string,
  agentId: string,
  at: string,
  overrides: Partial<ChatTurnEntry> = {}
): StreamEntry {
  return turnRow({
    id,
    author: { kind: "agent", agentId },
    text: `answer ${id}`,
    createdAt: at,
    turn: {
      prompt: { source: "chat", text: `prompt ${id}`, attachments: [] },
      trace: {
        startedAt: at,
        endedAt: at,
        finalResult: "ok",
        steps: [
          {
            id: `${id}:s1`,
            kind: "execute",
            label: "pnpm test",
            status: "ok",
            startedAt: at,
            endedAt: at,
            detail: { input: { command: "pnpm test" } },
          },
          {
            id: `${id}:s2`,
            kind: "read",
            label: "read a.ts",
            status: "ok",
            startedAt: at,
            endedAt: at,
            detail: { locations: [{ path: "a.ts" }] },
          },
        ],
      },
      ...overrides,
    },
  });
}

/** A block from `from` (an agent) addressed to `to`. */
function agentPost(
  id: string,
  from: string,
  to: string | null,
  text: string,
  at = "2026-09-02T10:00:00.000Z"
): StreamEntry {
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: from },
      toAgentId: to,
      text,
      delivered: true,
      createdAt: at,
    })
  );
}

function typeAndSend(text: string) {
  const input = screen.getByTestId("chat-composer-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  markdownRenders.count = 0;
  H.entries = [];
  H.unreadCount = 0;
  H.isLoading = false;
  H.error = null;
  H.refetch.mockReset();
  H.send.mockReset();
  H.answer.mockReset();
  H.markRead.mockReset();
  H.threadRoot = null;
  H.agents = [];
  H.rootId = null;
  H.descendants = new Set();
  H.streamIds = [];
  Element.prototype.scrollTo = vi.fn();
  clearChatScrollMemory();
});

afterEach(() => {
  cleanup();
});

describe("questionExcerpt", () => {
  it("takes the first meaningful line, stripped of markdown, and truncates", () => {
    expect(questionExcerpt("## Ship it?\n\nMore detail")).toBe("Ship it?");
    expect(questionExcerpt("**Bold** question")).toBe("Bold question");
    expect(questionExcerpt("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});

describe("entryOwner / filterStreamView", () => {
  const T = "2026-09-02T10:00:00.000Z";
  const rootView: StreamView = {
    agentId: "agt_1",
    rootId: "agt_1",
    descendants: new Set(["agt_child", "agt_grandchild"]),
  };
  const childView: StreamView = {
    agentId: "agt_child",
    rootId: "agt_1",
    descendants: new Set(["agt_grandchild"]),
  };
  const entries: StreamEntry[] = [
    turnEntry("root-turn", "agt_1", T),
    turnEntry("child-turn", "agt_child", T),
    turnEntry("grandchild-turn", "agt_grandchild", T),
    turnEntry("sibling-turn", "agt_sibling", T),
    blockEntry(block({ id: "human-chat", authorKind: "user" })),
    agentPost("root-reply", "agt_1", null, "for people"),
    agentPost("child-reply", "agt_child", null, "child for people"),
    agentPost("from-child", "agt_child", "agt_1", "to root"),
    agentPost("to-child", "agt_1", "agt_child", "to child"),
    agentPost("to-grandchild", "agt_child", "agt_grandchild", "launch"),
    blockEntry(
      block({
        id: "child-launch",
        authorKind: "user",
        toAgentId: "agt_child",
        origin: "launch",
      })
    ),
  ];
  const ids = (list: StreamEntry[]) => list.map((entry) => entry.id);

  it("gives the root's page everything, with descendants' rows as child activity", () => {
    expect(ids(filterStreamView(entries, rootView, true))).toEqual(
      ids(entries)
    );
    expect(ids(filterStreamView(entries, rootView, false))).toEqual([
      "root-turn",
      "sibling-turn",
      "human-chat",
      "root-reply",
      "to-child",
    ]);
  });

  it("filters a child's page to its own turns and the posts by or to it", () => {
    expect(ids(filterStreamView(entries, childView, false))).toEqual([
      "child-turn",
      "child-reply",
      "from-child",
      "to-child",
      "to-grandchild",
      "child-launch",
    ]);
    // Its own children fold in below it, as on the root's page.
    expect(ids(filterStreamView(entries, childView, true))).toEqual([
      "child-turn",
      "grandchild-turn",
      "child-reply",
      "from-child",
      "to-child",
      "to-grandchild",
      "child-launch",
    ]);
  });

  it("names whose a row is", () => {
    expect(entryOwner(entries[0]!, rootView)).toBe("own");
    expect(entryOwner(entries[1]!, rootView)).toBe("child");
    // A turn is its agent's block like any other: one by an agent outside
    // the tree, for people, is the stream's and so the root's, and no
    // child's.
    expect(entryOwner(entries[3]!, rootView)).toBe("own");
    expect(entryOwner(entries[3]!, childView)).toBe("other");
  });
});

describe("ChatPane", () => {
  it("reads the root's stream and posts to the page's agent", async () => {
    H.rootId = "agt_root";
    H.entries = [blockEntry(block({ id: "human-chat", text: "hi" }))];
    renderPane({ agentId: "agt_child", agent: { ...agent, id: "agt_child" } });
    expect(H.streamIds).toContain("agt_root");
    expect(H.streamIds).not.toContain("agt_child");

    typeAndSend("do this");
    await waitFor(() => expect(H.send).toHaveBeenCalled());
    expect(H.send.mock.calls[0]![0]).toMatchObject({
      text: "do this",
      to: "agt_child",
    });
  });

  it("posts to the root with no recipient from the root's own page", async () => {
    H.entries = [blockEntry(block({ id: "human-chat", text: "hi" }))];
    renderPane();
    typeAndSend("do this");
    await waitFor(() => expect(H.send).toHaveBeenCalled());
    expect(H.send.mock.calls[0]![0]).not.toHaveProperty("to");
  });

  it("shows a child's page the root stream filtered to the child", () => {
    H.rootId = "agt_1";
    H.entries = [
      turnEntry("root-turn", "agt_1", "2026-09-02T10:00:00.000Z"),
      turnEntry("child-turn", "agt_child", "2026-09-02T10:01:00.000Z"),
      agentPost("to-child", "agt_1", "agt_child", "please review"),
      agentPost("root-reply", "agt_1", null, "for people"),
    ];
    renderPane({
      agentId: "agt_child",
      agent: { ...agent, id: "agt_child", name: "reviewer" },
    });
    expect(screen.queryByText("answer root-turn")).toBeNull();
    expect(screen.queryByText("for people")).toBeNull();
    expect(screen.getByText("answer child-turn")).toBeTruthy();
    expect(screen.getByText("please review")).toBeTruthy();
  });

  it("shows a child's turn as a post under the child's name, like the parent's", async () => {
    H.agents = [
      { ...agent, id: "agt_1", name: "demo" },
      { ...agent, id: "agt_child", name: "reviewer", parentAgentId: "agt_1" },
    ];
    H.descendants = new Set(["agt_child"]);
    H.entries = [
      turnEntry("root-turn", "agt_1", "2026-09-02T10:00:00.000Z"),
      turnEntry("child-turn", "agt_child", "2026-09-02T10:01:00.000Z"),
    ];
    renderPane();
    // Both answers are in full; the child's under its own name.
    expect(screen.getByText("answer root-turn")).toBeTruthy();
    expect(screen.getByText("answer child-turn")).toBeTruthy();
    const posts = screen.getAllByTestId("chat-message");
    const childPost = posts.find(
      (post) => post.getAttribute("data-block-id") === "child-turn"
    )!;
    expect(childPost.getAttribute("data-author")).toBe("peer");
    expect(childPost.getAttribute("data-origin")).toBe("turn");
    await waitFor(() =>
      expect(
        childPost.querySelector('[data-testid="chat-post-author"]')?.textContent
      ).toBe("reviewer")
    );
    // Its steps fold under the answer, as the parent's do.
    expect(
      childPost.querySelector('[data-testid="chat-turn"]')
    ).not.toBeNull();
  });

  it("removes child activity from the rendered feed when filtered", () => {
    H.descendants = new Set(["agt_child"]);
    H.entries = [
      agentPost("from-child", "agt_child", "agt_1", "child update"),
      turnEntry("child-turn", "agt_child", "2026-09-02T10:00:30.000Z"),
      blockEntry(block({ id: "human-chat", text: "visible reply" })),
    ];

    renderPane({ showChildAgents: false });

    expect(screen.queryByText("child update")).toBeNull();
    expect(screen.queryByText("answer child-turn")).toBeNull();
    expect(screen.getByText("visible reply")).toBeTruthy();
  });

  it("does not treat filtering or hidden child activity as visible appends", () => {
    H.descendants = new Set(["agt_child"]);
    const childEntry = agentPost(
      "from-child",
      "agt_child",
      "agt_1",
      "child update",
      "2026-09-02T10:01:00.000Z"
    );
    H.entries = [
      blockEntry(block({ id: "human-chat", text: "visible reply" })),
      childEntry,
    ];
    const baseProps = {
      agentId: "agt_1",
      agent,
      active: true,
      onShowChildAgentsChange: vi.fn(),
      openLightbox: vi.fn(),
      isMobile: false,
    };
    const { rerender } = render(
      <ChatPane {...baseProps} showChildAgents={true} />,
      { wrapper: Wrapper }
    );
    const scroll = screen.getByTestId("chat-scroll");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(scroll);

    rerender(<ChatPane {...baseProps} showChildAgents={false} />);
    // Scrolled up, the way back is offered; nothing new is marked on it.
    expect(
      screen.queryByTestId("chat-jump-to-bottom")?.getAttribute("data-pending")
    ).toBeFalsy();

    H.entries = [
      ...H.entries,
      agentPost(
        "new-hidden-child",
        "agt_child",
        "agt_1",
        "still hidden",
        "2026-09-02T10:02:00.000Z"
      ),
    ];
    rerender(<ChatPane {...baseProps} showChildAgents={false} />);
    // Scrolled up, the way back is offered; nothing new is marked on it.
    expect(
      screen.queryByTestId("chat-jump-to-bottom")?.getAttribute("data-pending")
    ).toBeFalsy();
    expect(screen.queryByText("still hidden")).toBeNull();
  });

  it("offers the jump-to-bottom button, marked, for a live row that lands mid-feed", () => {
    const first = blockEntry(
      block({
        id: "a1",
        text: "first",
        createdAt: "2026-09-02T10:00:00.000Z",
      })
    );
    const last = blockEntry(
      block({ id: "a2", text: "last", createdAt: "2026-09-02T10:05:00.000Z" })
    );
    H.entries = [first, last];
    const { rerender } = renderPane();
    const scroll = screen.getByTestId("chat-scroll");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(scroll);
    // Scrolled up, the way back is offered; nothing new is marked on it.
    expect(
      screen.queryByTestId("chat-jump-to-bottom")?.getAttribute("data-pending")
    ).toBeFalsy();

    H.entries = [
      first,
      agentPost(
        "from-child",
        "agt_child",
        "agt_1",
        "landed late",
        "2026-09-02T10:03:00.000Z"
      ),
      last,
    ];
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={agent}
        active={true}
        showChildAgents={true}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(
      screen.getByTestId("chat-jump-to-bottom").getAttribute("data-pending")
    ).toBe("true");
  });

  it("does not re-render memoised posts when the pane re-renders with equal data", async () => {
    H.entries = [blockEntry(block({ id: "a", text: "**bold** body" }))];
    const stable = {
      onShowChildAgentsChange: vi.fn(),
      openLightbox: vi.fn(),
    };
    const { rerender } = renderPane(stable);
    // Let mount-time queries (peers, injection hold) settle, then take the
    // baseline so the assertion measures only what the rerender does. The
    // query cache notifies on a macrotask, so a microtask flush is not enough.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const settled = markdownRenders.count;
    // Every agent.upsert hands the pane a fresh agent object with the same
    // content; the row context must stay referentially stable through it.
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={{ ...agent }}
        active={true}
        showChildAgents={true}
        isMobile={false}
        {...stable}
      />
    );
    expect(markdownRenders.count).toBe(settled);
  });

  it("explains a filter-only empty feed and can show child activity again", () => {
    const onShowChildAgentsChange = vi.fn();
    H.descendants = new Set(["agt_child"]);
    H.entries = [agentPost("from-child", "agt_child", "agt_1", "child update")];

    renderPane({ showChildAgents: false, onShowChildAgentsChange });

    const empty = screen.getByTestId("chat-empty");
    expect(empty.classList.contains("h-full")).toBe(true);
    expect(empty.textContent).toContain("Child-agent activity is hidden");
    expect(empty.textContent).not.toContain("No messages yet");
    fireEvent.click(screen.getByRole("button", { name: "Show child agents" }));
    expect(onShowChildAgentsChange).toHaveBeenCalledWith(true);
  });

  it("shows the empty state while the feed has no blocks", () => {
    H.entries = [];
    renderPane();
    const empty = screen.getByTestId("chat-empty");
    expect(empty.textContent).toContain("Send the first one below");
    expect(screen.queryByTestId("chat-message")).toBeNull();
  });

  it("hides the empty state once a chat message exists", () => {
    H.entries = [blockEntry(block({ id: "a1", text: "hello" }))];
    renderPane();
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("draws the prompt as the user's own row above the turn's answer", () => {
    H.entries = [
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "run the tests",
          delivered: true,
          createdAt: "2026-09-02T10:00:00.000Z",
        })
      ),
      turnEntry("t1", "agt_1", "2026-09-02T10:00:05.000Z"),
    ];
    renderPane();
    const posts = screen.getAllByTestId("chat-message");
    expect(
      posts.map((post) => [
        post.getAttribute("data-author"),
        post.getAttribute("data-origin"),
      ])
    ).toEqual([
      ["user", null],
      ["agent", "turn"],
    ]);
    expect(posts[0]!.textContent).toContain("run the tests");
    expect(posts[1]!.textContent).toContain("answer t1");
    expect(posts[1]!.textContent).not.toContain("prompt t1");
    expect(screen.getByTestId("chat-turn").getAttribute("data-turn-id")).toBe(
      "t1"
    );
  });

  it("sends a plain message when no free-text question is open", () => {
    H.entries = [blockEntry(block({ id: "a1" }))];
    renderPane();
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
    typeAndSend("hello there");
    expect(H.send).toHaveBeenCalledWith({
      text: "hello there",
      attachments: [],
    });
    expect(H.answer).not.toHaveBeenCalled();
  });

  it("treats any block, even a bare file post, as a conversation", () => {
    H.entries = [
      blockEntry(
        block({
          id: "file:1",
          text: "",
          body: FILE_BODY,
          attachments: [
            { type: "file", fileId: 1, fileName: "shot.png", sizeBytes: 10 },
          ],
          createdAt: "2026-09-02T10:00:01.000Z",
        })
      ),
    ];
    renderPane();
    expect(screen.queryByTestId("chat-empty")).toBeNull();
    expect(screen.getByTestId("chat-attachment-image")).toBeTruthy();
  });

  it("offers a retry and blocks sending while the feed failed to load", () => {
    H.error = new Error("boom");
    renderPane();
    expect(screen.getByTestId("chat-feed-error").textContent).toContain("boom");
    fireEvent.click(screen.getByTestId("chat-feed-retry"));
    expect(H.refetch).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    expect(
      screen.getByTestId("chat-composer-disabled-reason").textContent
    ).toContain("retry above");
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("blocks sending while the feed is still loading", () => {
    H.isLoading = true;
    renderPane();
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("answers the newest open free-text question with what was typed", () => {
    H.entries = [
      blockEntry(
        block({
          id: "q1",
          text: "Which branch should I use?",
          body: questionBody([{ label: "main" }], { allowFreeform: true }),
        })
      ),
    ];
    renderPane();
    expect(screen.getByTestId("chat-reply-context").textContent).toContain(
      "Which branch should I use?"
    );
    typeAndSend("release/2.0");
    expect(H.answer).toHaveBeenCalledWith({
      blockId: "q1",
      value: "release/2.0",
      attachments: [],
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("answers a free-text question through the answer route even with attachments", async () => {
    H.entries = [
      blockEntry(
        block({
          id: "q1",
          text: "Which spec?",
          body: questionBody([{ label: "main" }], { allowFreeform: true }),
        })
      ),
    ];
    H.answer.mockImplementation(async () => {
      // The answered question comes back from the server; the pane then
      // has nothing left to reply to.
      H.entries = [
        blockEntry(
          block({
            id: "q1",
            text: "Which spec?",
            body: questionBody([{ label: "main" }], {
              allowFreeform: true,
              state: answered("this one", undefined, "r1"),
            }),
          })
        ),
      ];
      return {} as never;
    });
    const { rerender } = renderPane();
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.paste(input, {
      clipboardData: { items: [], getData: () => "https://example.com/spec" },
    });
    expect(screen.getByTestId("chat-reply-context")).toBeTruthy();
    typeAndSend("this one");
    expect(H.answer).toHaveBeenCalledWith({
      blockId: "q1",
      value: "this one",
      attachments: [{ type: "link", url: "https://example.com/spec" }],
    });
    expect(H.send).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement).value
      ).toBe("")
    );
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={agent}
        active={true}
        showChildAgents={true}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
    expect(screen.queryByTestId("chat-composer-attachments")).toBeNull();
  });

  it("sends a plain message after the reply context is dismissed", () => {
    H.entries = [
      blockEntry(
        block({
          id: "q1",
          text: "Which branch?",
          body: questionBody([{ label: "main" }], { allowFreeform: true }),
        })
      ),
    ];
    renderPane();
    fireEvent.click(screen.getByTestId("chat-reply-context-dismiss"));
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
    typeAndSend("unrelated note");
    expect(H.send).toHaveBeenCalledWith({
      text: "unrelated note",
      attachments: [],
    });
    expect(H.answer).not.toHaveBeenCalled();
  });

  it("does not offer the reply context for an option-only question", () => {
    H.entries = [
      blockEntry(
        block({
          id: "q1",
          text: "Pick one",
          body: questionBody([{ label: "A" }, { label: "B" }]),
        })
      ),
    ];
    renderPane();
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
  });
});

describe("ChatPane running turn", () => {
  /** The newest turn's block: empty text until it settles. */
  function turn(
    overrides: Partial<ChatTurnEntry> = {},
    text = ""
  ): StreamEntry {
    return turnRow({
      id: "turn:1",
      text,
      createdAt: "2026-09-02T10:00:00.000Z",
      turn: {
        updatedAt: "2026-09-02T10:00:05.000Z",
        prompt: { source: "chat", text: "run the tests", attachments: [] },
        trace: {
          startedAt: "2026-09-02T10:00:00.000Z",
          steps: [],
        },
        result: { text: "", streaming: true },
        settled: false,
        interrupted: false,
        ...overrides,
      },
    });
  }

  it("offers Stop while the newest turn runs, and cancels it through the runtime", async () => {
    H.entries = [turn()];
    renderPane();
    const stop = screen.getByTestId("chat-stop-turn");
    vi.mocked(api).mockClear();
    fireEvent.click(stop);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/runtime/cancel", {
        method: "POST",
      })
    );
  });

  it("hides Stop once the newest turn has settled", () => {
    H.entries = [
      turn(
        {
          settled: true,
          trace: {
            startedAt: "2026-09-02T10:00:00.000Z",
            endedAt: "2026-09-02T10:00:05.000Z",
            steps: [],
          },
          result: { text: "done", streaming: false },
        },
        "done"
      ),
    ];
    renderPane();
    expect(screen.queryByTestId("chat-stop-turn")).toBeNull();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("shows the newest turn's plan above the composer while work is left", () => {
    H.entries = [
      turn({
        plan: [
          {
            content: "write the test",
            status: "completed",
            priority: "medium",
          },
          {
            content: "make it pass",
            status: "in_progress",
            priority: "medium",
          },
        ],
      }),
    ];
    renderPane();
    expect(screen.getByTestId("harness-tasks")).toBeTruthy();
  });
});

describe("ChatPane scroll memory", () => {
  /** jsdom has no layout; hand the pane the geometry it reads. */
  function stubLayout(scrollTop: number) {
    const scroll = screen.getByTestId("chat-scroll");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: scrollTop, writable: true },
    });
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
    const rows = [
      ...scroll.querySelectorAll<HTMLElement>("[data-chat-entry-id]"),
    ];
    rows.forEach((row, i) => {
      // Rows 100px tall, stacked, shifted by however far the feed is scrolled.
      row.getBoundingClientRect = () =>
        ({
          top: i * 100 - scrollTop,
          bottom: i * 100 + 100 - scrollTop,
        }) as DOMRect;
    });
    return scroll;
  }

  it("records the rows on screen when the reader leaves", () => {
    H.entries = [
      blockEntry(block({ id: "m1", text: "one" })),
      blockEntry(block({ id: "m2", text: "two" })),
      blockEntry(block({ id: "m3", text: "three" })),
    ];
    const { unmount } = renderPane();
    const scroll = stubLayout(250);
    fireEvent.scroll(scroll);
    unmount();

    // 250px down: the first two rows are above the fold, so the reader is
    // parked on the third, 50px of it scrolled past.
    expect(readChatScrollPosition("agt_1")).toEqual({
      following: false,
      anchors: [{ entryId: "m3", offset: -50 }],
    });
  });

  it("keeps recording through a long scroll, not only at its ends", () => {
    vi.useFakeTimers();
    try {
      H.entries = [
        blockEntry(block({ id: "m1", text: "one" })),
        blockEntry(block({ id: "m2", text: "two" })),
        blockEntry(block({ id: "m3", text: "three" })),
      ];
      const { unmount } = renderPane();
      // One unbroken fling: every event resets the trailing timer, so it
      // never fires, and the reader switches away mid-gesture. What is
      // recorded must not be the position from the start of the gesture.
      fireEvent.scroll(stubLayout(50));
      vi.advanceTimersByTime(REMEMBER_THROTTLE_MS);
      fireEvent.scroll(stubLayout(150));
      vi.advanceTimersByTime(REMEMBER_THROTTLE_MS);
      fireEvent.scroll(stubLayout(250));
      unmount();

      expect(readChatScrollPosition("agt_1")?.anchors[0]).toEqual({
        entryId: "m3",
        offset: -50,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays following when the reader leaves from the bottom", () => {
    H.entries = [blockEntry(block({ id: "m1", text: "one" }))];
    const { unmount } = renderPane();
    const scroll = stubLayout(800);
    fireEvent.scroll(scroll);
    unmount();

    expect(readChatScrollPosition("agt_1")?.following).toBe(true);
  });

  it("reopens on the remembered row instead of the newest message", () => {
    rememberChatScrollPosition("agt_1", {
      following: false,
      anchors: [{ entryId: "m2", offset: -50 }],
    });
    H.entries = [
      blockEntry(block({ id: "m1", text: "one" })),
      blockEntry(block({ id: "m2", text: "two" })),
    ];

    renderPane();

    // Rects are all zero here, so the row sits 50px above where it was left.
    expect(screen.getByTestId("chat-scroll").scrollTop).toBe(50);
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("falls back to a lower row when the top one no longer exists", () => {
    // The row the reader was on is gone (rolled off the loaded page, or
    // deleted); the next remembered row below it stands in.
    rememberChatScrollPosition("agt_1", {
      following: false,
      anchors: [
        { entryId: "status-that-moved-on", offset: -20 },
        { entryId: "m2", offset: -50 },
      ],
    });
    H.entries = [
      blockEntry(block({ id: "m1", text: "one" })),
      blockEntry(block({ id: "m2", text: "two" })),
    ];

    renderPane();

    expect(screen.getByTestId("chat-scroll").scrollTop).toBe(50);
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("opens at the newest message when every remembered row is gone", () => {
    rememberChatScrollPosition("agt_1", {
      following: false,
      anchors: [{ entryId: "rolled-off", offset: -50 }],
    });
    H.entries = [blockEntry(block({ id: "m1", text: "one" }))];

    renderPane();

    expect(Element.prototype.scrollTo).toHaveBeenCalled();
  });

  it("forgets the agents nobody has looked at in longest", () => {
    for (let i = 0; i < 60; i += 1) {
      rememberChatScrollPosition(`agt_${i}`, {
        following: false,
        anchors: [{ entryId: `m${i}`, offset: 0 }],
      });
    }

    expect(readChatScrollPosition("agt_0")).toBeNull();
    expect(readChatScrollPosition("agt_9")).toBeNull();
    expect(readChatScrollPosition("agt_10")?.anchors[0]?.entryId).toBe("m10");
    expect(readChatScrollPosition("agt_59")?.anchors[0]?.entryId).toBe("m59");
  });
});

describe("isMainColumnEntry", () => {
  it("leaves a turn a thread reply opened to the drawer", () => {
    const plain = turnEntry("turn:1", "agt_1", "2026-09-02T10:00:00.000Z");
    expect(isMainColumnEntry(plain)).toBe(true);
    // Its answer block lands in the thread, as any reply does.
    expect(
      isMainColumnEntry({
        ...plain,
        block: { ...plain.block, threadId: "root", replyTo: "r1" },
      })
    ).toBe(false);
  });
});

describe("ChatPane threads", () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-search">{location.search}</div>;
  }

  function renderWithUrl(search: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/agents/agt_1${search}`]}>
          <ChatPane
            agentId="agt_1"
            agent={agent}
            active={true}
            showChildAgents={true}
            onShowChildAgentsChange={vi.fn()}
            openLightbox={vi.fn()}
            isMobile={false}
          />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  const root = block({
    id: "root",
    text: "Plan",
    replyCount: 3,
    lastReplyAt: "2026-09-02T10:05:00.000Z",
    unreadReplies: 2,
    repliers: [{ kind: "user" }, { kind: "agent", agentId: "agt_1" }],
  });

  it("shows a reply line on a threaded block and puts the thread into the URL for the drawer", () => {
    H.entries = [blockEntry(root)];
    H.threadRoot = root;
    renderWithUrl("");
    const line = screen.getByTestId("chat-thread-line");
    expect(line.textContent).toContain("3 replies");
    expect(line.textContent).toContain("last");
    // The row shows who wrote in the thread and what is new in it.
    expect(line.querySelectorAll('[data-testid="chat-thread-replier"]')).toHaveLength(2);
    expect(screen.getByTestId("chat-thread-unread").textContent).toBe("2 new");
    fireEvent.click(line);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?thread=root"
    );
    // The thread itself is the drawer's, not the pane's.
    expect(screen.queryByTestId("chat-thread-panel")).toBeNull();
  });

  it("leaves the composer unfocused while a thread is open in the drawer", () => {
    H.entries = [blockEntry(root)];
    H.threadRoot = root;
    renderWithUrl("?thread=root&finding=f1");
    expect(screen.queryByTestId("chat-thread-panel")).toBeNull();
    expect(document.activeElement).not.toBe(
      screen.getByTestId("chat-composer-input")
    );
  });

  it("keeps replies out of the main column", () => {
    H.entries = [
      blockEntry(root),
      blockEntry(
        block({
          id: "r1",
          authorKind: "user",
          text: "a reply",
          threadId: "root",
          replyTo: "root",
          createdAt: "2026-09-02T10:05:00.000Z",
        })
      ),
    ];
    renderWithUrl("");
    expect(
      screen
        .getAllByTestId("chat-message")
        .map((p) => p.getAttribute("data-block-id"))
    ).toEqual(["root"]);
  });
});
