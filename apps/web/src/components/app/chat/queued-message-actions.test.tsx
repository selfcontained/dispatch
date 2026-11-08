// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueuedMessageActions } from "./queued-message-actions";
const state = vi.hoisted(() => ({ turn: "turn_a", steering: true }));
vi.mock("@/lib/api", () => ({ api: vi.fn(async () => ({})) }));
vi.mock("@/hooks/use-agent-tree", () => ({
  useDeliveryAgents: () => [
    {
      id: "agent",
      currentTurn: { blockId: state.turn },
      inputState: {
        active: true,
        interruptSupported: true,
        steeringSupported: state.steering,
        conversation: { streamId: "agent", threadId: null },
      },
    },
  ],
}));
afterEach(cleanup);
beforeEach(() => {
  state.turn = "turn_a";
  state.steering = true;
});
function setup() {
  const client = new QueryClient();
  const view = (pending: boolean) => (
    <QueryClientProvider client={client}>
      <QueuedMessageActions
        agentId="agent"
        messageId="message"
        recipientIds={["agent"]}
        pendingDelivery={pending}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(true));
  return (pending: boolean) => rendered.rerender(view(pending));
}
it("releases the success latch when pending delivery becomes held", async () => {
  const rerender = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send now" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Interrupt requested",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  );
  rerender(false);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  );
  expect(
    (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
      .disabled
  ).toBe(false);
});
it("allows a fresh interrupt after the active recipient turn changes", async () => {
  const rerender = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send now" }));
  await screen.findByRole("button", { name: "Interrupt requested" });
  state.turn = "turn_b";
  rerender(true);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  );
});

it("sends a queued thread message into ongoing work without interrupting", async () => {
  const { api } = await import("@/lib/api");
  vi.mocked(api).mockClear();
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <QueuedMessageActions
        agentId="agent"
        messageId="thread-message"
        recipientIds={["agent"]}
        threadId="other-thread"
      />
    </QueryClientProvider>
  );
  const button = screen.getByRole("button", { name: "Send now" });
  expect(button.title).toContain("replies stay in its current conversation");
  fireEvent.click(button);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining("/thread-message/send-now"),
      { method: "POST", body: JSON.stringify({ interrupt: false }) }
    )
  );
});

it.each(["image", "interrupt-only"])(
  "keeps an explicit interrupt fallback for thread %s",
  async (kind) => {
    const { api } = await import("@/lib/api");
    vi.mocked(api).mockClear();
    state.steering = kind !== "interrupt-only";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <QueuedMessageActions
          agentId="agent"
          messageId="thread-fallback"
          recipientIds={["agent"]}
          threadId="thread"
          requiresNextTurn={kind === "image"}
        />
      </QueryClientProvider>
    );
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Interrupt and reply" })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/thread-fallback/send-now"),
        { method: "POST", body: JSON.stringify({ interrupt: true }) }
      )
    );
  }
);
