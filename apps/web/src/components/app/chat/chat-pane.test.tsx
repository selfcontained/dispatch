// @vitest-environment jsdom
import type { ChatFeedEntry, ChatMessage } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import {
  ChatPane,
  filterChildAgentMessages,
  questionExcerpt,
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
  markRead: vi.fn(),
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
    mutate: vi.fn(),
    mutateAsync: H.send,
    isPending: false,
    variables: undefined,
  }),
  useAnswerChatQuestion: () => ({
    mutate: vi.fn(),
    mutateAsync: H.answer,
    isPending: false,
    variables: undefined,
  }),
  useMarkChatRead: () => H.markRead,
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
    { wrapper }
  );
}

function typeAndSend(text: string) {
  const input = screen.getByTestId("chat-composer-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  H.entries = [];
  H.unreadCount = 0;
  H.isLoading = false;
  H.error = null;
  H.refetch.mockReset();
  H.send.mockReset();
  H.answer.mockReset();
  H.markRead.mockReset();
  Element.prototype.scrollTo = vi.fn();
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
      { wrapper }
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
