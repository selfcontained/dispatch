// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StreamEntry } from "@dispatch/shared";
import type { Agent } from "@/components/app/types";
import { TaskConversation } from "./task-conversation";

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  agents: [] as unknown[],
  markRead: vi.fn(),
}));
const review = {
  id: "review-1",
  block: {
    id: "review-1",
    threadId: null,
    kind: "review",
    text: "",
    author: { kind: "agent", agentId: "a" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
} as unknown as StreamEntry;
const turn = (text: string) =>
  ({
    id: "turn-1",
    block: {
      id: "turn-1",
      threadId: null,
      kind: "text",
      text,
      author: { kind: "agent", agentId: "a" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      turn: {
        updatedAt: `t${text.length}`,
        settled: false,
        trace: { steps: [] },
      },
    },
  }) as unknown as StreamEntry;

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const answer = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeed: () => ({
    entries: state.entries,
    unreadCount: 0,
    isLoading: false,
    error: null,
    hasOlder: false,
    isFetchingOlder: false,
    loadOlder: vi.fn(),
    refetch: vi.fn(),
    agentNames: {},
  }),
  usePostBlock: () => mutation,
  useAnswerQuestion: () => answer,
  useSubmitForm: () => mutation,
  useSetBlockState: () => mutation,
  useToggleReaction: () => mutation,
  useRetryDelivery: () => mutation,
  useMarkStreamRead: () => state.markRead,
}));
vi.mock("@/hooks/use-agent-tree", () => ({
  useDeliveryAgents: () => state.agents,
}));
// The feed context is the handlers it was given: the stand-in feed calls
// onOpenThread the way a review's finding row does.
vi.mock("@/components/app/chat/use-chat-feed-context", () => ({
  useChatFeedContext: (input: unknown) => ({ ctx: input }),
}));
vi.mock("@/components/app/chat/chat-feed", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  latestAgentBlockId: () => null,
  ChatFeed: ({
    ctx,
    answersDisabled,
    onAnswer,
  }: {
    ctx: { onOpenThread: (id: string, findingId?: string) => void };
    answersDisabled: boolean;
    onAnswer: (blockId: string, option: { label: string }) => void;
  }) => (
    <>
      <button onClick={() => ctx.onOpenThread("review-1", "finding-1")}>
        Open finding
      </button>
      <button
        disabled={answersDisabled}
        onClick={() => onAnswer("question-1", { label: "Ship it" })}
      >
        Ship it
      </button>
    </>
  ),
}));
vi.mock("@/components/app/chat/chat-composer", () => ({
  ChatComposer: ({ mentionables }: { mentionables: { name: string }[] }) => (
    <output data-testid="composer-mentions">
      {mentionables.map((agent) => agent.name).join(",")}
    </output>
  ),
}));
vi.mock("@/components/app/file-lightbox", () => ({ FileLightbox: () => null }));
vi.mock("@/components/app/drawer/thread-page", () => ({
  ThreadPage: ({
    blockId,
    findingId,
    disabledReason,
    mentionables,
  }: {
    blockId: string;
    findingId: string | null;
    disabledReason?: string | null;
    mentionables?: { name: string }[];
  }) => (
    <output
      data-testid="thread-page"
      data-disabled-reason={
        disabledReason === undefined ? "derived" : (disabledReason ?? "open")
      }
      data-mentions={mentionables?.map((agent) => agent.name).join(",")}
    >
      {blockId}/{findingId ?? "none"}
    </output>
  ),
}));

afterEach(() => {
  cleanup();
  state.entries = [review];
  state.agents = [];
  state.markRead.mockClear();
});
state.entries = [review];

const conversation = (memberIds: string[] = [], active = true) => (
  <TaskConversation
    taskId="tsk_1"
    active={active}
    assignee={null}
    isMobile={false}
    memberIds={memberIds}
  />
);

it("opens a review finding as its own thread", () => {
  render(conversation());
  fireEvent.click(screen.getByRole("button", { name: "Open finding" }));
  expect(screen.getByTestId("thread-page").textContent).toBe(
    "review-1/finding-1"
  );
});

it("still answers an agent's question after the task is unassigned", () => {
  // Agent A asked; the task now has no assignee. The answer goes to A.
  render(conversation());
  const button = screen.getByRole("button", { name: "Ship it" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  expect(answer.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ blockId: "question-1", label: "Ship it" }),
    expect.anything()
  );
});

it("keeps a thread opened from an unassigned task open for replies and answers", () => {
  render(conversation());
  fireEvent.click(screen.getByRole("button", { name: "Open finding" }));
  // Not the assignee-derived reason ("Select an agent…"): the feed is ready.
  expect(
    screen.getByTestId("thread-page").getAttribute("data-disabled-reason")
  ).toBe("open");
});

it("offers the task's agents for mentions, in the composer and threads", () => {
  const agent = (id: string, extra: Partial<Agent> = {}) =>
    ({ id, name: id, status: "running", ...extra }) as Agent;
  state.agents = [
    agent("assignee"),
    agent("assignee-child", { parentAgentId: "assignee" }),
    agent("member-elsewhere", { parentAgentId: "other-root" }),
  ];
  render(conversation(["assignee", "member-elsewhere"]));
  expect(screen.getByTestId("composer-mentions").textContent).toBe(
    "assignee,member-elsewhere"
  );
  fireEvent.click(screen.getByRole("button", { name: "Open finding" }));
  expect(screen.getByTestId("thread-page").getAttribute("data-mentions")).toBe(
    "assignee,member-elsewhere"
  );
});

it("follows a turn as it grows under one id, until the reader scrolls up", () => {
  state.entries = [turn("a")];
  const view = render(conversation());
  const scroller = screen.getByTestId("task-conversation-scroll");
  let height = 200;
  let top = 0;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 100 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
  });
  for (const text of ["ab", "abc", "abcd"]) {
    height += 150;
    state.entries = [turn(text)];
    view.rerender(conversation());
    expect(top).toBe(height);
  }
  // The reader scrolls up to read: growth no longer moves them.
  top = 0;
  fireEvent.scroll(scroller);
  height += 150;
  state.entries = [turn("abcde")];
  view.rerender(conversation());
  expect(top).toBe(0);
});

it("only marks read when the Conversation tab is active", () => {
  const view = render(conversation([], false));
  expect(state.markRead).not.toHaveBeenCalled();
  view.rerender(conversation([], true));
  expect(state.markRead).toHaveBeenCalledTimes(1);
  view.rerender(conversation([], false));
  state.entries = [turn("new hidden post")];
  view.rerender(conversation([], false));
  expect(state.markRead).toHaveBeenCalledTimes(1);
  view.rerender(conversation([], true));
  expect(state.markRead).toHaveBeenCalledTimes(2);
});

it("re-pins a following feed after hidden scroll resets without changing a reader's scroll-up choice", () => {
  const view = render(conversation());
  const scroller = screen.getByTestId("task-conversation-scroll");
  let top = 400;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => 500 },
    clientHeight: { configurable: true, get: () => 100 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
  });
  view.rerender(conversation([], false));
  top = 0;
  fireEvent.scroll(scroller);
  expect(top).toBe(0);
  view.rerender(conversation([], true));
  expect(top).toBe(500);
  top = 10;
  fireEvent.scroll(scroller);
  view.rerender(conversation([], false));
  top = 0;
  fireEvent.scroll(scroller);
  view.rerender(conversation([], true));
  expect(top).toBe(0);
});
