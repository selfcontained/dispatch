// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StreamEntry } from "@dispatch/shared";
import { TaskConversation } from "./task-conversation";

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const answer = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeed: () => ({
    entries: [
      {
        id: "review-1",
        block: { id: "review-1", threadId: null, kind: "review" },
      } as unknown as StreamEntry,
    ],
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
  useMarkStreamRead: () => vi.fn(),
}));
vi.mock("@/hooks/use-agent-tree", () => ({ useDeliveryAgents: () => [] }));
// The feed context is the handlers it was given: the stand-in feed calls
// onOpenThread the way a review's finding row does.
vi.mock("@/components/app/chat/use-chat-feed-context", () => ({
  useChatFeedContext: (input: unknown) => ({ ctx: input }),
}));
vi.mock("@/components/app/chat/chat-feed", () => ({
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
  ChatComposer: () => null,
}));
vi.mock("@/components/app/file-lightbox", () => ({ FileLightbox: () => null }));
vi.mock("@/components/app/drawer/thread-page", () => ({
  ThreadPage: ({
    blockId,
    findingId,
  }: {
    blockId: string;
    findingId: string | null;
  }) => (
    <output data-testid="thread-page">
      {blockId}/{findingId ?? "none"}
    </output>
  ),
}));

afterEach(cleanup);

it("opens a review finding as its own thread", () => {
  render(<TaskConversation taskId="tsk_1" assignee={null} isMobile={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Open finding" }));
  expect(screen.getByTestId("thread-page").textContent).toBe(
    "review-1/finding-1"
  );
});

it("still answers an agent's question after the task is unassigned", () => {
  // Agent A asked; the task now has no assignee. The answer goes to A.
  render(<TaskConversation taskId="tsk_1" assignee={null} isMobile={false} />);
  const button = screen.getByRole("button", { name: "Ship it" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  expect(answer.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ blockId: "question-1", label: "Ship it" }),
    expect.anything()
  );
});
