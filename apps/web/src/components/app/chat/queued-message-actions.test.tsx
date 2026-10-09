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
const state = vi.hoisted(() => ({ turn: "turn_a" }));
vi.mock("@/lib/api", () => ({ api: vi.fn(async () => ({})) }));
vi.mock("@/hooks/use-agent-tree", () => ({
  useDeliveryAgents: () => [
    {
      id: "agent",
      currentTurn: { blockId: state.turn },
      inputState: {
        active: true,
        interruptSupported: true,
        steeringSupported: true,
        conversation: { streamId: "agent", threadId: null },
      },
    },
  ],
}));
afterEach(cleanup);
beforeEach(() => {
  state.turn = "turn_a";
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
