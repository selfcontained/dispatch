import type { Block } from "@dispatch/shared";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ArchivedConversation } from "./archived-conversation";
import { block } from "@/test-utils/blocks";

const H = vi.hoisted(() => ({
  feed: {
    entries: [] as unknown[],
    agentNames: {},
    isLoading: false,
    isFetchingOlder: false,
    hasOlder: false,
    error: null,
    loadOlder: vi.fn(),
    refetch: vi.fn(),
  },
  thread: {
    root: null as ReturnType<typeof block> | null,
    replies: [] as ReturnType<typeof block>[],
    agentNames: {},
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  },
  threadQuery: vi.fn(),
  ctx: undefined as unknown,
}));
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeed: () => H.feed,
  useThread: (_agentId: string, blockId: string | null) => {
    H.threadQuery(blockId);
    return H.thread;
  },
}));
vi.mock("@/hooks/use-agent-tree", () => ({ useAgentRecord: () => null }));
vi.mock("@/hooks/use-block-jump", () => ({ useBlockJump: vi.fn() }));
vi.mock("./agent-chat-navigation", () => ({ AgentChatNavigation: () => null }));
vi.mock("./chat/conversation-location-link", () => ({
  ConversationReturnLink: () => <span>Back to agent home</span>,
}));
vi.mock("./file-lightbox", () => ({ FileLightbox: () => null }));
vi.mock("./chat/chat-pane", () => ({
  visibleStreamEntries: (entries: unknown[]) => entries,
}));
vi.mock("./chat/chat-feed", () => ({
  ChatFeed: ({ ctx }: { ctx: unknown }) => {
    H.ctx = ctx;
    return <div>Stored home feed</div>;
  },
}));
vi.mock("./chat/chat-entries", () => ({
  BlockView: ({
    block,
    ctx,
    answersDisabled,
  }: {
    block: Block;
    ctx: unknown;
    answersDisabled: boolean;
  }) => {
    H.ctx = ctx;
    return <div data-disabled={String(answersDisabled)}>{block.text}</div>;
  },
}));
afterEach(() => {
  cleanup();
  H.thread.root = null;
  H.thread.replies = [];
  H.threadQuery.mockClear();
  H.feed.entries = [];
  H.feed.hasOlder = false;
  H.feed.loadOlder.mockClear();
});
function mount(search: string) {
  function Location() {
    const location = useLocation();
    return <output data-testid="location">{location.search}</output>;
  }
  return render(
    <MemoryRouter initialEntries={["/activity/history/archived" + search]}>
      <ArchivedConversation agentId="archived" name="Old agent" type="codex" />
      <Location />
    </MemoryRouter>
  );
}
it("renders archived thread and reply anchors without authoring controls", () => {
  H.thread.root = block({ id: "thread", text: "Old source" });
  H.thread.replies = [
    block({ id: "reply", text: "Old answer", threadId: "thread" }),
  ];
  mount("?thread=thread&block=reply&returnAgent=worker");
  expect(screen.getByText("Old source")).toBeTruthy();
  expect(
    screen
      .getByText("Old answer")
      .closest("[data-chat-entry-id]")
      ?.getAttribute("data-chat-entry-id")
  ).toBe("reply");
  expect(H.ctx).toMatchObject({ readOnly: true });
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(screen.getByTestId("location").textContent).toBe(
    "?returnAgent=worker"
  );
});
it("opens findings at their stored thread and returns to the review", () => {
  H.thread.root = block({ id: "finding", text: "Archived finding" });
  mount("?thread=review&finding=finding&block=finding");
  expect(H.threadQuery).toHaveBeenCalledWith("finding");
  expect(screen.getByText("Archived finding")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
  expect(screen.getByTestId("location").textContent).toBe("?thread=review");
});
it("seeks older pages for an archived block-only link", () => {
  H.feed.hasOlder = true;
  mount("?block=old");
  expect(H.feed.loadOlder).toHaveBeenCalled();
  expect(screen.getByText("Stored home feed")).toBeTruthy();
});
