// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadPage } from "./thread-page";

const mutation = { mutate: vi.fn(), isPending: false };
vi.mock("@/hooks/use-stream", () => ({
  useAnswerQuestion: () => mutation,
  useSubmitForm: () => mutation,
  useSetBlockState: () => mutation,
  useToggleReaction: () => mutation,
  useRetryDelivery: () => mutation,
}));
vi.mock("@/components/app/chat/use-chat-feed-context", () => ({
  useChatFeedContext: () => ({ ctx: {} }),
}));
// The panel gates both its reply composer and its answer controls on this.
vi.mock("@/components/app/chat/thread-panel", () => ({
  ThreadPanel: ({ disabledReason }: { disabledReason: string | null }) => (
    <output data-testid="panel">{disabledReason ?? "open"}</output>
  ),
}));

afterEach(cleanup);

const props = {
  agentId: "tsk_1",
  agent: null,
  rootId: "tsk_1",
  blockId: "block-1",
  findingId: null,
  isMobile: false,
  openLightbox: vi.fn(),
  onOpenThread: vi.fn(),
  onBack: vi.fn(),
};

it("derives the disabled reason from the agent by default", () => {
  render(<ThreadPage {...props} />);
  expect(screen.getByTestId("panel").textContent).toBe(
    "Select an agent to chat with."
  );
});

it("lets the caller open replies and answers with no agent", () => {
  render(<ThreadPage {...props} disabledReason={null} />);
  expect(screen.getByTestId("panel").textContent).toBe("open");
});
