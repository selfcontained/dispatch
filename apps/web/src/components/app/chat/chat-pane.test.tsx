// @vitest-environment jsdom
import type {
  ChatFeedEntry,
  ChatMessage,
  ChatTurnEntry,
} from "@dispatch/shared";
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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { chatDraftAtomFamily } from "@/lib/store";

import {
  ChatPane,
  clearChatScrollMemory,
  filterChildAgentMessages,
  questionExcerpt,
  readChatScrollPosition,
  REMEMBER_THROTTLE_MS,
  rememberChatScrollPosition,
} from "./chat-pane";
import {
  composerHint,
  harnessPromptHistory,
  latestContextUsage,
  latestTurnPlan,
  newestTurnEntry,
} from "./harness-chrome";

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
}));
const API = vi.hoisted(() => ({
  call: vi.fn(async () => ({ agents: [] })),
}));

// No real request may be in flight under a test: the pane's peers query
// (`GET /api/v1/agents`) would otherwise hit whatever answers the jsdom
// origin, and a resolved directory re-renders every post.
vi.mock("@/lib/api", () => ({
  api: API.call,
}));

vi.mock("@/hooks/use-chat", () => ({
  useChatFeed: () => ({
    entries: H.entries,
    unreadCount: H.unreadCount,
    hasOlder: false,
    isLoading: H.isLoading,
    isFetchingOlder: false,
    error: H.error,
    loadOlder: vi.fn(),
    refetch: H.refetch,
  }),
  useSendChatMessage: () => ({
    mutate: H.sendNow,
    mutateAsync: H.send,
    isPending: false,
    variables: undefined,
  }),
  useAnswerChatQuestion: () => ({
    mutate: H.answerNow,
    mutateAsync: H.answer,
    isPending: false,
    variables: undefined,
  }),
  useMarkChatRead: () => H.markRead,
  // One mutate for the whole file: the feed's rows are memoised on a context
  // built from it.
  useToggleChatReaction: (() => {
    const mutate = vi.fn();
    return () => ({ mutate });
  })(),
}));
const HARNESS = vi.hoisted(() => ({
  queued: [] as import("@dispatch/shared").HarnessQueuedPrompt[],
  sendNow: vi.fn(async (_id: string) => {}),
  remove: vi.fn(async (_id: string) => {}),
  interrupt: vi.fn(async () => {}),
}));

vi.mock("@/components/app/harness/use-harness-queue", () => ({
  harnessQueueQueryKey: (agentId: string | null) => ["harness-queue", agentId],
  useQueuedPrompts: () => ({
    queued: HARNESS.queued,
    loading: false,
    error: null,
  }),
  useHarnessQueue: () => ({
    sendNow: HARNESS.sendNow,
    remove: HARNESS.remove,
    busyId: null,
  }),
  useHarnessInterrupt: () => ({
    interrupt: HARNESS.interrupt,
    interrupting: false,
  }),
}));
vi.mock(
  "@/components/app/harness/use-harness-config",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/app/harness/use-harness-config")
    >()),
    // `running: true` because the shared fixture is a running agent, and
    // the chip shows the activity bars in place of the engine's mark while
    // the agent runs without a session.
    useHarnessConfig: () => ({
      running: true,
      options: [],
      model: undefined,
      effort: undefined,
      loading: false,
    }),
    useSetHarnessConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  })
);
// The dialog reads a full query result; `api` is mocked file-wide, so the
// real hook would hand it `{ agents: [] }` and `data.engines.map` would throw.
vi.mock("@/components/app/harness/use-harness-usage", () => ({
  HARNESS_USAGE_QUERY_KEY: ["harness-usage"],
  useHarnessUsage: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/components/app/harness/use-harness-auth", () => ({
  HARNESS_AUTH_QUERY_KEY: ["harness-auth"],
  useHarnessAuth: () => ({
    data: {
      checkedAt: "2026-09-11T00:00:00.000Z",
      engines: [
        {
          engineId: "codex",
          kind: "subscription",
          label: "ChatGPT subscription",
        },
      ],
    },
  }),
}));
vi.mock("@/components/app/harness/use-harness-commands", () => ({
  harnessCommandsQueryKey: (agentId: string | null) => [
    "harness-commands",
    agentId,
  ],
  useHarnessCommands: () => [],
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
  tmuxSession: null,
  agentArgs: [],
  model: null,
  fullAccess: false,
  mediaDir: null,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  latestEvent: {
    type: "working",
    message: "Running tests",
    updatedAt: "2026-09-02T10:00:00.000Z",
    metadata: null,
  },
};

const dispatchAgent: Agent = {
  ...agent,
  type: "dispatch",
  model: "codex/default",
};

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

function turnEntry(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
  return {
    type: "turn",
    id: "turn:1",
    agentId: "agt_1",
    at: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:09.000Z",
    prompt: {
      source: "chat",
      text: "read the readme",
      chatMessageId: "m-prompt",
      attachments: [],
    },
    trace: {
      startedAt: "2026-09-02T10:00:00.000Z",
      endedAt: "2026-09-02T10:00:09.000Z",
      finalResult: "ok",
      steps: [],
    },
    result: { text: "It documents the CLI.", streaming: false },
    settled: true,
    interrupted: false,
    ...overrides,
  };
}

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
      terminalMode="tmux"
      active={true}
      showChildAgents={true}
      childAgentIds={[]}
      onShowChildAgentsChange={vi.fn()}
      openLightbox={vi.fn()}
      isMobile={false}
      {...props}
    />,
    { wrapper: Wrapper }
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
  API.call.mockClear();
  HARNESS.queued = [];
  // Cleared, not reset: on Vitest 2 mockReset() drops the async body too,
  // so interrupt() would return undefined and onStop's .catch would throw.
  HARNESS.sendNow.mockClear();
  HARNESS.remove.mockClear();
  HARNESS.interrupt.mockClear();
  // The draft atom is keyed by agent and outlives a render, so an unsent
  // draft left by an earlier case would make ArrowUp a history walk
  // instead of a recall.
  window.localStorage.clear();
  chatDraftAtomFamily.remove("agt_1");
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

describe("filterChildAgentMessages", () => {
  const childMessage = (
    id: string,
    senderAgentId: string,
    recipientAgentId: string
  ): ChatFeedEntry => ({
    type: "agent_message",
    id,
    direction: senderAgentId === "agt_1" ? "out" : "in",
    senderAgentId,
    senderName: senderAgentId,
    recipientAgentId,
    recipientName: recipientAgentId,
    content: id,
    delivered: true,
    at: "2026-09-02T10:00:00.000Z",
  });

  const entries = [
    childMessage("from-child", "agt_child", "agt_1"),
    childMessage("to-child", "agt_1", "agt_child"),
    childMessage("other-agent", "agt_other", "agt_1"),
    chat(message({ id: "human-chat" })),
  ];

  it("keeps all entries while child agents are shown", () => {
    expect(
      filterChildAgentMessages(entries, new Set(["agt_child"]), true)
    ).toHaveLength(4);
  });

  it("hides both directions of child-agent messages only", () => {
    expect(
      filterChildAgentMessages(entries, new Set(["agt_child"]), false).map(
        (entry) => entry.id
      )
    ).toEqual(["other-agent", "human-chat"]);
  });

  it("uses feed lineage when an archived child is absent from the live list", () => {
    const archivedChild = {
      ...childMessage("archived-child", "agt_archived", "agt_1"),
      involvesChildAgent: true,
    };
    expect(
      filterChildAgentMessages(
        [...entries, archivedChild],
        new Set(),
        false
      ).map((entry) => entry.id)
    ).toEqual(["from-child", "to-child", "other-agent", "human-chat"]);
  });
});

describe("ChatPane", () => {
  it("removes child-agent messages from the rendered feed when filtered", () => {
    H.entries = [
      {
        type: "agent_message",
        id: "from-child",
        direction: "in",
        senderAgentId: "agt_child",
        senderName: "child",
        recipientAgentId: "agt_1",
        recipientName: "demo",
        content: "child update",
        delivered: true,
        at: "2026-09-02T10:00:00.000Z",
      },
      chat(message({ id: "human-chat", text: "visible reply" })),
    ];

    renderPane({ showChildAgents: false, childAgentIds: ["agt_child"] });

    expect(screen.queryByText("child update")).toBeNull();
    expect(screen.getByText("visible reply")).toBeTruthy();
  });

  it("does not treat filtering or hidden child messages as visible appends", () => {
    const childEntry: ChatFeedEntry = {
      type: "agent_message",
      id: "from-child",
      direction: "in",
      senderAgentId: "agt_child",
      senderName: "child",
      recipientAgentId: "agt_1",
      recipientName: "demo",
      content: "child update",
      delivered: true,
      at: "2026-09-02T10:01:00.000Z",
    };
    H.entries = [
      chat(message({ id: "human-chat", text: "visible reply" })),
      childEntry,
    ];
    const baseProps = {
      agentId: "agt_1",
      agent,
      terminalMode: "tmux" as const,
      active: true,
      childAgentIds: ["agt_child"],
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
    expect(screen.queryByText("New messages")).toBeNull();

    H.entries = [
      ...H.entries,
      { ...childEntry, id: "new-hidden-child", content: "still hidden" },
    ];
    rerender(<ChatPane {...baseProps} showChildAgents={false} />);
    expect(screen.queryByText("New messages")).toBeNull();
    expect(screen.queryByText("still hidden")).toBeNull();
  });

  it("offers the New messages pill for a live row that lands mid-feed", () => {
    const first = chat(
      message({
        id: "a1",
        text: "first",
        createdAt: "2026-09-02T10:00:00.000Z",
      })
    );
    const last = chat(
      message({ id: "a2", text: "last", createdAt: "2026-09-02T10:05:00.000Z" })
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
    expect(screen.queryByText("New messages")).toBeNull();

    H.entries = [
      first,
      {
        type: "status",
        id: "event:late",
        eventType: "working",
        message: "Late status",
        at: "2026-09-02T10:03:00.000Z",
      },
      last,
    ];
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={agent}
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        childAgentIds={[]}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(screen.getByText("New messages")).toBeTruthy();
  });

  it("does not re-render memoised posts when the pane re-renders with equal data", async () => {
    H.entries = [chat(message({ id: "a", text: "**bold** body" }))];
    const stable = {
      onShowChildAgentsChange: vi.fn(),
      openLightbox: vi.fn(),
      childAgentIds: [] as string[],
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
        agent={{ ...agent, pins: [...(agent.pins ?? [])] }}
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        isMobile={false}
        {...stable}
      />
    );
    expect(markdownRenders.count).toBe(settled);
  });

  it("explains a filter-only empty feed and can show child messages again", () => {
    const onShowChildAgentsChange = vi.fn();
    H.entries = [
      {
        type: "agent_message",
        id: "from-child",
        direction: "in",
        senderAgentId: "agt_child",
        senderName: "child",
        recipientAgentId: "agt_1",
        recipientName: "demo",
        content: "child update",
        delivered: true,
        at: "2026-09-02T10:00:00.000Z",
      },
    ];

    renderPane({
      showChildAgents: false,
      childAgentIds: ["agt_child"],
      onShowChildAgentsChange,
    });

    const empty = screen.getByTestId("chat-empty");
    expect(empty.classList.contains("h-full")).toBe(true);
    expect(empty.textContent).toContain("Child-agent messages are hidden");
    expect(empty.textContent).not.toContain("No messages yet");
    fireEvent.click(screen.getByRole("button", { name: "Show child agents" }));
    expect(onShowChildAgentsChange).toHaveBeenCalledWith(true);
  });

  it("shows the empty state when there are no chat messages, keeping other entries", () => {
    H.entries = [
      {
        type: "status",
        id: "event:1",
        eventType: "working",
        message: "Booting",
        at: "2026-09-02T10:00:00.000Z",
      },
    ];
    renderPane();
    const empty = screen.getByTestId("chat-empty");
    expect(empty.textContent).toContain("Send the first one below");
    expect(empty.textContent).toContain("before Chat was enabled");
    expect(screen.getByTestId("chat-status").textContent).toContain("Booting");
  });

  it("hides the empty state once a chat message exists", () => {
    H.entries = [chat(message({ id: "a1", text: "hello" }))];
    renderPane();
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("sends a plain message when no free-text question is open", () => {
    H.entries = [chat(message({ id: "a1" }))];
    renderPane();
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
    typeAndSend("hello there");
    expect(H.send).toHaveBeenCalledWith({
      text: "hello there",
      attachments: [],
    });
    expect(H.answer).not.toHaveBeenCalled();
  });

  it("treats status-only history as empty but any written entry as a conversation", () => {
    H.entries = [
      {
        type: "status",
        id: "event:1",
        eventType: "working",
        message: "Booting",
        at: "2026-09-02T10:00:00.000Z",
      },
      {
        type: "media",
        id: "media:1",
        mediaId: 1,
        fileName: "shot.png",
        sizeBytes: 10,
        description: null,
        at: "2026-09-02T10:00:01.000Z",
      },
    ];
    renderPane();
    expect(screen.queryByTestId("chat-empty")).toBeNull();
    expect(screen.getByTestId("chat-media")).toBeTruthy();
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
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Which branch should I use?",
          question: { options: [{ label: "main" }], allowFreeform: true },
        })
      ),
    ];
    renderPane();
    expect(screen.getByTestId("chat-reply-context").textContent).toContain(
      "Which branch should I use?"
    );
    typeAndSend("release/2.0");
    expect(H.answer).toHaveBeenCalledWith({
      messageId: "q1",
      value: "release/2.0",
      attachments: [],
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("answers a free-text question through the answer route even with attachments", async () => {
    H.entries = [
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Which spec?",
          question: { options: [{ label: "main" }], allowFreeform: true },
        })
      ),
    ];
    H.answer.mockImplementation(async () => {
      // The answered question comes back from the server; the pane then
      // has nothing left to reply to.
      H.entries = [
        chat(
          message({
            id: "q1",
            kind: "question",
            text: "Which spec?",
            question: { options: [{ label: "main" }], allowFreeform: true },
            answer: {
              value: "this one",
              replyMessageId: "r1",
              answeredAt: "2026-09-02T10:01:00.000Z",
            },
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
      messageId: "q1",
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
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        childAgentIds={[]}
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
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Which branch?",
          question: { options: [{ label: "main" }], allowFreeform: true },
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
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Pick one",
          question: { options: [{ label: "A" }, { label: "B" }] },
        })
      ),
    ];
    renderPane();
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
  });

  it("lets an inert agent collect messages in its stream", () => {
    renderPane({ terminalMode: "inert" });
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(false);
    expect(screen.queryByTestId("chat-composer-disabled-reason")).toBeNull();
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
      chat(message({ id: "m1", text: "one" })),
      chat(message({ id: "m2", text: "two" })),
      chat(message({ id: "m3", text: "three" })),
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
        chat(message({ id: "m1", text: "one" })),
        chat(message({ id: "m2", text: "two" })),
        chat(message({ id: "m3", text: "three" })),
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
    H.entries = [chat(message({ id: "m1", text: "one" }))];
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
      chat(message({ id: "m1", text: "one" })),
      chat(message({ id: "m2", text: "two" })),
    ];

    renderPane();

    // Rects are all zero here, so the row sits 50px above where it was left.
    expect(screen.getByTestId("chat-scroll").scrollTop).toBe(50);
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("falls back to a lower row when the top one no longer exists", () => {
    // What a collapsed run of `working` events does: the status row the
    // reader was on now carries a newer event's id.
    rememberChatScrollPosition("agt_1", {
      following: false,
      anchors: [
        { entryId: "status-that-moved-on", offset: -20 },
        { entryId: "m2", offset: -50 },
      ],
    });
    H.entries = [
      chat(message({ id: "m1", text: "one" })),
      chat(message({ id: "m2", text: "two" })),
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
    H.entries = [chat(message({ id: "m1", text: "one" }))];

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

describe("composerHint", () => {
  it("says what Enter and the arrows do for each state", () => {
    expect(composerHint(false, 0)).toBeUndefined();
    expect(composerHint(true, 0)).toBe(
      "Agent is working · Enter queues your message · Ctrl+C stops"
    );
    expect(composerHint(true, 2)).toBe(
      "Agent is working · Enter queues your message · ↑ edits the newest queued message · Ctrl+C stops"
    );
    expect(composerHint(false, 1)).toBe(
      "Message queued · ↑ edits the newest queued message"
    );
  });

  it("drops the key hints on a touch keyboard", () => {
    // Neither ArrowUp nor Ctrl+C exists there, and the four-part string
    // wraps to three lines under a 320px field. The Stop button and the
    // queued row's own actions cover both on touch.
    expect(composerHint(true, 2, true)).toBe(
      "Agent is working · Enter queues your message"
    );
    expect(composerHint(false, 1, true)).toBe("Message queued");
    expect(composerHint(false, 0, true)).toBeUndefined();
  });
});

describe("newestTurnEntry", () => {
  it("takes the last turn in the feed whatever follows it", () => {
    const found = newestTurnEntry([
      chat(message({ id: "m0", text: "before" })),
      turnEntry({ id: "turn:1", settled: true }),
      turnEntry({ id: "turn:2", settled: false }),
      chat(message({ id: "m1", text: "after" })),
    ]);
    expect(found?.id).toBe("turn:2");
    expect(found?.settled).toBe(false);
  });

  it("is null when the feed carries no turn", () => {
    expect(newestTurnEntry([chat(message({ id: "m0" }))])).toBeNull();
    expect(newestTurnEntry([])).toBeNull();
  });
});

describe("latestContextUsage", () => {
  it("uses the newest report from the current live session", () => {
    expect(
      latestContextUsage(
        [
          turnEntry({
            id: "turn:old",
            at: "2026-09-11T00:00:00Z",
            usage: { used: 90, size: 100, costUsd: null },
          }),
          turnEntry({
            id: "turn:new",
            at: "2026-09-11T02:00:00Z",
            usage: { used: 25, size: 100, costUsd: 0.5 },
          }),
        ],
        "2026-09-11T01:00:00Z"
      )
    ).toEqual({ used: 25, size: 100, costUsd: 0.5 });
  });

  it("does not reuse context from an earlier session", () => {
    expect(
      latestContextUsage(
        [
          turnEntry({
            at: "2026-09-11T00:00:00Z",
            usage: { used: 90, size: 100, costUsd: null },
          }),
        ],
        "2026-09-11T01:00:00Z"
      )
    ).toBeNull();
  });

  it("does not label the last report as current while no session is live", () => {
    expect(
      latestContextUsage([
        turnEntry({ usage: { used: 90, size: 100, costUsd: null } }),
      ])
    ).toBeNull();
  });
});

describe("latestTurnPlan", () => {
  it("takes the newest turn that published a plan, running or settled", () => {
    expect(
      latestTurnPlan([
        turnEntry({
          id: "turn:1",
          plan: [{ content: "old", status: "completed", priority: "low" }],
        }),
        turnEntry({
          id: "turn:2",
          settled: false,
          plan: [
            {
              content: "Read the README",
              status: "completed",
              priority: "high",
            },
            {
              content: "Echo the prompt",
              status: "in_progress",
              priority: "medium",
            },
          ],
        }),
      ])
    ).toEqual([
      { content: "Read the README", status: "completed" },
      { content: "Echo the prompt", status: "in_progress" },
    ]);
  });

  it("looks past a later turn that published none", () => {
    expect(
      latestTurnPlan([
        turnEntry({
          id: "turn:1",
          plan: [{ content: "keep me", status: "pending", priority: "low" }],
        }),
        turnEntry({ id: "turn:2" }),
      ])
    ).toEqual([{ content: "keep me", status: "pending" }]);
  });

  it("is empty when no turn published one", () => {
    expect(latestTurnPlan([turnEntry(), chat(message({ id: "m0" }))])).toEqual(
      []
    );
  });
});

describe("harnessPromptHistory", () => {
  it("keeps the typed prompts in order without immediate repeats", () => {
    expect(
      harnessPromptHistory([
        turnEntry({
          id: "turn:1",
          prompt: { source: "chat", text: "first", attachments: [] },
        }),
        turnEntry({
          id: "turn:2",
          prompt: { source: "chat", text: " first ", attachments: [] },
        }),
        turnEntry({
          id: "turn:3",
          prompt: { source: "chat", text: "second", attachments: [] },
        }),
      ])
    ).toEqual(["first", "second"]);
  });

  it("leaves out launch, agent and system prompts and empty text", () => {
    expect(
      harnessPromptHistory([
        turnEntry({
          id: "turn:1",
          prompt: { source: "launch", text: "kickoff", attachments: [] },
        }),
        turnEntry({
          id: "turn:2",
          prompt: {
            source: "agent",
            text: "from a peer",
            senderName: "Reviewer",
            attachments: [],
          },
        }),
        turnEntry({
          id: "turn:3",
          prompt: { source: "system", text: "injected", attachments: [] },
        }),
        turnEntry({
          id: "turn:4",
          prompt: { source: "chat", text: "   ", attachments: [] },
        }),
        turnEntry({
          id: "turn:5",
          prompt: { source: "chat", text: "mine", attachments: [] },
        }),
      ])
    ).toEqual(["mine"]);
  });
});

describe("ChatPane harness chrome", () => {
  it("mounts no chrome and no harness controls for an agent that is not a dispatch agent", () => {
    renderPane();
    expect(screen.queryByTestId("chat-harness-chrome")).toBeNull();
    expect(screen.queryByTestId("harness-model-chip")).toBeNull();
    expect(screen.queryByTestId("harness-usage-chip")).toBeNull();
    expect(screen.queryByTestId("harness-stop")).toBeNull();
    expect(screen.queryByTestId("harness-status-line")).toBeNull();
  });

  it("wears the engine's mark on the model chip for the model it was launched with", () => {
    renderPane({ agent: dispatchAgent });
    const mark = screen
      .getByTestId("harness-model-chip")
      .querySelector('[data-testid="provider-icon"]');
    expect(mark?.getAttribute("data-provider")).toBe("openai");
    expect(
      screen.getByTestId("harness-model-chip-label").textContent
    ).toContain("Codex");
    expect(screen.getByTestId("harness-auth-codex").textContent).toContain(
      "ChatGPT subscription"
    );
  });

  it("falls back to the default engine's mark and login command when no model is stored", () => {
    // An agent created on the default path stores no model on older rows,
    // and the chip and the hint both read the engine off the model.
    renderPane({
      agent: {
        ...dispatchAgent,
        model: null,
        status: "error",
        latestEvent: {
          type: "blocked",
          message: "Claude Code is not logged in on the server.",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    const mark = screen
      .getByTestId("harness-model-chip")
      .querySelector('[data-testid="provider-icon"]');
    expect(mark?.getAttribute("data-provider")).toBe("anthropic");
    expect(screen.getByTestId("harness-login-hint").textContent).toContain(
      "claude /login"
    );
  });

  it("shows the reason and the login command whether or not the feed has turns", () => {
    // The old surface put this in an empty state, so an engine whose login
    // lapsed mid-life showed nothing at all once the agent had history.
    H.entries = [turnEntry()];
    renderPane({
      agent: {
        ...dispatchAgent,
        status: "error",
        latestEvent: {
          type: "blocked",
          message: "Codex is not logged in on the server.",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    expect(screen.getByTestId("harness-status-line").textContent).toContain(
      "Codex is not logged in on the server."
    );
    expect(screen.getByTestId("harness-login-hint").textContent).toContain(
      "codex login --device-auth"
    );
  });

  it("opens Console and starts provider login after an OAuth failure", async () => {
    H.entries = [
      turnEntry({
        trace: {
          startedAt: "2026-09-02T10:00:00.000Z",
          endedAt: "2026-09-02T10:00:09.000Z",
          finalResult: "error",
          steps: [],
        },
        result: {
          text: "Failed to authenticate: OAuth session expired",
          streaming: false,
        },
        error: "authentication_failed",
      }),
    ];
    const onOpenConsole = vi.fn();
    renderPane({ agent: dispatchAgent, onOpenConsole });

    fireEvent.click(screen.getByTestId("harness-login-action"));

    await waitFor(() => {
      expect(API.call).toHaveBeenCalledWith(
        "/api/v1/agents/agt_1/terminal/inject-text",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            text: "codex login --device-auth",
            submit: true,
          }),
        })
      );
      expect(onOpenConsole).toHaveBeenCalledTimes(1);
    });
  });

  it("says the harness is not running once, under the field, not twice", () => {
    // The composer prints the disabled reason itself. The status line used
    // to fall back to the same sentence, so an agent that errored without a
    // message of its own showed it top and bottom of the same 60px.
    renderPane({
      agent: { ...dispatchAgent, status: "error", latestEvent: undefined },
    });
    expect(screen.queryByTestId("harness-status-line")).toBeNull();
    expect(
      screen.getByTestId("chat-composer-disabled-reason").textContent
    ).toContain("The harness is not running. Press Start to relaunch it.");
  });

  it("names what the harness is doing while it starts and opens nothing from the faded chips", () => {
    // The chrome animates to opacity 0 but stays mounted, so without the
    // pointer-events and tabindex guards a click on blank space opened the
    // portaled Model dialog.
    renderPane({
      agent: {
        ...dispatchAgent,
        status: "creating",
        latestEvent: {
          type: "working",
          message: "Installing dependencies…",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    const line = screen.getByTestId("harness-status-line");
    expect(line.textContent).toContain("Installing dependencies…");
    expect(line.querySelector('[role="status"]')).not.toBeNull();
    const chip = screen.getByTestId("harness-model-chip");
    expect(chip.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(chip);
    expect(screen.queryByTestId("harness-model-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("harness-usage-chip"));
    expect(screen.queryByTestId("harness-usage-dialog")).toBeNull();
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
  });

  it("keeps the composer mounted across the starting handoff", () => {
    const { rerender } = renderPane({
      agent: { ...dispatchAgent, status: "creating" },
    });
    const input = screen.getByTestId("chat-composer-input");
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={dispatchAgent}
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        childAgentIds={[]}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(screen.getByTestId("chat-composer-input")).toBe(input);
  });

  it("pins the current task list above the composer and folds it", () => {
    H.entries = [
      turnEntry({
        plan: [
          { content: "Read the README", status: "completed", priority: "high" },
          {
            content: "Echo the prompt",
            status: "in_progress",
            priority: "medium",
          },
          { content: "Wrap up", status: "pending", priority: "low" },
        ],
      }),
    ];
    renderPane({ agent: dispatchAgent });
    const strip = screen.getByTestId("harness-tasks");
    expect(screen.getByTestId("harness-tasks-presence")).not.toBeNull();
    expect(strip.textContent).toContain("1 of 3 done");
    const items = strip.querySelectorAll('[data-testid="harness-todo-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-status")).toBe("in_progress");
    expect(screen.getByTestId("harness-tasks-more").textContent).toBe(
      "+1 more"
    );
    fireEvent.click(screen.getByTestId("harness-tasks-more"));
    expect(
      strip.querySelectorAll('[data-testid="harness-todo-item"]')
    ).toHaveLength(3);
    fireEvent.click(screen.getByTestId("harness-tasks-toggle"));
    expect(strip.querySelector('[data-testid="harness-todo-list"]')).toBeNull();
    expect(strip.textContent).toContain("Echo the prompt");
  });

  it("drops the strip once every task is done", () => {
    H.entries = [
      turnEntry({
        plan: [
          { content: "Read the README", status: "completed", priority: "high" },
          { content: "Wrap up", status: "completed", priority: "low" },
        ],
      }),
    ];
    renderPane({ agent: dispatchAgent });
    expect(screen.queryByTestId("harness-tasks")).toBeNull();
  });

  it("lists queued prompts above the composer with Send now and Remove", () => {
    HARNESS.queued = [
      {
        id: "m2",
        source: "chat",
        text: "second thoughts",
        chatMessageId: "m2",
        attachments: [],
        createdAt: "2026-09-04T10:00:01.000Z",
      },
      {
        id: "q_3",
        source: "agent",
        text: "and mine",
        senderName: "Reviewer",
        attachments: [],
        createdAt: "2026-09-04T10:00:02.000Z",
      },
    ];
    renderPane({ agent: dispatchAgent });
    const rows = screen.getAllByTestId("harness-queued");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("second thoughts");
    expect(rows[0]?.textContent).toContain("Queued");
    expect(rows[1]?.textContent).toContain("from Reviewer");
    const chrome = screen.getByTestId("chat-harness-chrome");
    expect(chrome.contains(rows[0]!)).toBe(true);
    expect(screen.getByTestId("chat-scroll").contains(rows[0]!)).toBe(false);

    fireEvent.click(
      rows[0]!.querySelector('[data-testid="harness-queued-send-now"]')!
    );
    expect(HARNESS.sendNow).toHaveBeenCalledWith("m2");
    fireEvent.click(
      rows[1]!.querySelector('[data-testid="harness-queued-remove"]')!
    );
    expect(HARNESS.remove).toHaveBeenCalledWith("q_3");
  });

  it("offers Stop while a turn runs and interrupts on click", () => {
    H.entries = [
      turnEntry({
        settled: false,
        trace: { startedAt: "2026-09-02T10:00:00.000Z", steps: [] },
        result: { text: "working", streaming: true },
      }),
    ];
    renderPane({ agent: dispatchAgent });
    const stop = screen.getByTestId("harness-stop");
    // React stringifies aria-* booleans, so the visible state reads "false".
    expect(stop.getAttribute("aria-hidden")).toBe("false");
    expect(stop.className).not.toContain("invisible");
    fireEvent.click(stop);
    expect(HARNESS.interrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps Stop laid out but hidden when nothing runs", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    const stop = screen.getByTestId("harness-stop");
    expect(stop.getAttribute("aria-hidden")).toBe("true");
    expect(stop.className).toContain("invisible");
  });

  it("opens the usage dialog from the chip", () => {
    renderPane({ agent: dispatchAgent });
    fireEvent.click(screen.getByTestId("harness-usage-chip"));
    expect(screen.getByTestId("harness-usage-dialog")).not.toBeNull();
  });

  it("keeps every chip a 44px target on a coarse pointer", () => {
    renderPane({ agent: dispatchAgent });
    for (const id of [
      "harness-model-chip",
      "harness-usage-chip",
      "harness-stop",
    ]) {
      expect(screen.getByTestId(id).className).toContain(
        "pointer-coarse:min-h-11"
      );
    }
    // Without min-w-0 the button's min-content is the whole nowrap label, so
    // the span's `truncate` never engages and the row overflows instead.
    expect(screen.getByTestId("harness-model-chip").className).toContain(
      "min-w-0"
    );
  });

  it("renders a turn's shortcut pins, because the pane provides the turn context", () => {
    H.entries = [
      turnEntry({
        trace: {
          startedAt: "2026-09-02T10:00:00.000Z",
          endedAt: "2026-09-02T10:00:09.000Z",
          finalResult: "ok",
          steps: [
            {
              id: "s1",
              kind: "other",
              label: "mcp__dispatch__dispatch_pins",
              status: "ok",
              startedAt: "2026-09-02T10:00:01.000Z",
              endedAt: "2026-09-02T10:00:02.000Z",
              durMs: 1000,
              detail: {
                input: {
                  pins: [
                    {
                      label: "Run the E2E",
                      type: "shortcut",
                      value: "run e2e",
                    },
                    { label: "Gone", type: "shortcut", value: "x" },
                  ],
                },
              },
            },
          ],
        },
      }),
    ];
    renderPane({
      agent: {
        ...dispatchAgent,
        pins: [
          {
            id: "p1",
            label: "Run the E2E",
            value: "run e2e",
            type: "shortcut",
            group: "Next steps",
          },
        ],
      },
    });
    const row = screen.getByTestId("harness-shortcuts");
    expect(
      [...row.querySelectorAll('[data-testid="pin-item"]')].map((i) =>
        i.getAttribute("data-pin-label")
      )
    ).toEqual(["Run the E2E"]);
  });
});

describe("ChatPane harness composer", () => {
  const runningTurn = () =>
    turnEntry({
      settled: false,
      trace: { startedAt: "2026-09-02T10:00:00.000Z", steps: [] },
      result: { text: "working", streaming: true },
    });

  const statusEntry = (id: string, at: string): ChatFeedEntry => ({
    type: "status",
    id,
    eventType: "working",
    message: "Reading the readme",
    at,
  });

  const queuedChat = {
    id: "m2",
    source: "chat" as const,
    text: "queued one",
    chatMessageId: "m2",
    attachments: [],
    createdAt: "2026-09-04T10:00:01.000Z",
  };

  it("says what Enter does while a turn runs and something waits behind it", () => {
    H.entries = [runningTurn()];
    HARNESS.queued = [queuedChat];
    renderPane({ agent: dispatchAgent });
    expect(screen.getByTestId("chat-composer-hint").textContent).toBe(
      "Agent is working · Enter queues your message · ↑ edits the newest queued message · Ctrl+C stops"
    );
  });

  it("keeps the plain composer line when nothing runs and nothing waits", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    expect(screen.queryByTestId("chat-composer-hint")).toBeNull();
    expect(screen.queryByTestId("harness-queued")).toBeNull();
  });

  it("gives no hint and no history to an agent that is not a dispatch agent", () => {
    H.entries = [runningTurn()];
    HARNESS.queued = [queuedChat];
    renderPane();
    expect(screen.queryByTestId("chat-composer-hint")).toBeNull();
  });

  it("pulls the queued message back on ArrowUp", async () => {
    HARNESS.queued = [queuedChat];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("queued one"));
    expect(HARNESS.remove).toHaveBeenCalledWith("m2");
  });

  it("refuses to recall a queued message that carries attachments", async () => {
    HARNESS.queued = [
      {
        ...queuedChat,
        id: "m3",
        text: "with a file",
        attachments: [
          { type: "file", mediaId: 1, fileName: "a.png", sizeBytes: 1 },
        ],
      },
    ];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("attachments")
    );
    expect(HARNESS.remove).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("recalls the user's own queued message, not one another agent sent", async () => {
    HARNESS.queued = [
      queuedChat,
      {
        ...queuedChat,
        id: "m9",
        source: "agent" as const,
        senderName: "child",
        text: "a child agent's undelivered message",
      },
    ];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("queued one"));
    // The child's message stays queued and undelivered.
    expect(HARNESS.remove).toHaveBeenCalledWith("m2");
    expect(HARNESS.remove).not.toHaveBeenCalledWith("m9");
  });

  it("walks back through the prompts the user typed before", async () => {
    H.entries = [
      turnEntry({
        id: "turn:1",
        prompt: { source: "chat", text: "earlier prompt", attachments: [] },
      }),
      turnEntry({ id: "turn:2" }),
    ];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("read the readme"));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("earlier prompt"));
  });

  it("stops the turn on Ctrl+C in the field while one runs", () => {
    H.entries = [runningTurn()];
    renderPane({ agent: dispatchAgent });
    fireEvent.keyDown(screen.getByTestId("chat-composer-input"), {
      key: "c",
      ctrlKey: true,
    });
    expect(HARNESS.interrupt).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+C alone when no turn runs", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    fireEvent.keyDown(screen.getByTestId("chat-composer-input"), {
      key: "c",
      ctrlKey: true,
    });
    expect(HARNESS.interrupt).not.toHaveBeenCalled();
  });

  it("opens the usage dialog from the /usage slash command", async () => {
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "/usage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("harness-usage-dialog")).not.toBeNull();
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("opens the model picker from the /model slash command", async () => {
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "/model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("harness-model-picker")).not.toBeNull();
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("keeps following a live turn when a status row lands under it", () => {
    // A turn is anchored where it started, so the status event the agent
    // emits mid-turn becomes the tail entry while the turn keeps growing.
    const running = runningTurn();
    H.entries = [running, statusEntry("event:9", "2026-09-02T10:00:05.000Z")];
    const { rerender } = renderPane({ agent: dispatchAgent });
    (Element.prototype.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    H.entries = [
      {
        ...running,
        updatedAt: "2026-09-02T10:00:20.000Z",
        result: { text: "working a good deal more", streaming: true },
      },
      statusEntry("event:9", "2026-09-02T10:00:05.000Z"),
    ];
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={dispatchAgent}
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        childAgentIds={[]}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(Element.prototype.scrollTo).toHaveBeenCalled();
  });

  it("shows the drop overlay only for a dispatch agent, while files are dragged over the pane", () => {
    const plain = renderPane();
    const plainPane = screen.getByTestId("chat-pane");
    fireEvent.dragOver(plainPane, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    plain.unmount();

    renderPane({ agent: dispatchAgent });
    const pane = screen.getByTestId("chat-pane");
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    fireEvent.dragOver(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("chat-drop-overlay")).not.toBeNull();
    expect(pane.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
  });
});
