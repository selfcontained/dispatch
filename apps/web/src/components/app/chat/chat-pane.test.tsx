// @vitest-environment jsdom
import type { ChatFeedEntry, ChatMessage } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import { ChatPane, questionExcerpt } from "./chat-pane";

// The pane's data layer is exercised elsewhere; here it is replaced so the
// pane's own decisions can be driven directly: what the composer does with a
// typed message, and what shows when the feed has no chat messages.
const H = vi.hoisted(() => ({
  entries: [] as unknown[],
  unreadCount: 0,
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
  send: vi.fn(async (_text: string) => ({}) as never),
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
      onOpenConsole={vi.fn()}
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

describe("ChatPane", () => {
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
    expect(H.send).toHaveBeenCalledWith("hello there");
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
    });
    expect(H.send).not.toHaveBeenCalled();
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
    expect(H.send).toHaveBeenCalledWith("unrelated note");
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

  it("disables the composer with a reason when the terminal is inert", () => {
    renderPane({ terminalMode: "inert" });
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    expect(
      screen.getByTestId("chat-composer-disabled-reason").textContent
    ).toContain("inert mode");
  });
});
