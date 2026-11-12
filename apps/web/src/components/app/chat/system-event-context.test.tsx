// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Post } from "./chat-entries";
import { DeliveryIndicator } from "./chat-delivery-meta";
import { block } from "@/test-utils/blocks";
import { ScheduledMessageEntry } from "./scheduled-message-entry";
const live = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("../scheduled-messages", async (original) => ({
  ...(await original<object>()),
  useScheduledMessages: () => ({ data: live.data }),
}));
vi.mock("../scheduled-messages-button", () => ({
  ScheduledMessagesButton: () => <button>Manage</button>,
}));
afterEach(() => {
  cleanup();
  live.data = [];
});
it("retains recipient, live receipt and context when a system event owns its heading", () => {
  const observation = block({
    author: { kind: "system" },
    toAgentId: "recipient",
    delivered: true,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Post
        author={{ key: "system", kind: "agent", name: "Dispatch" }}
        at={observation.createdAt}
        grouped={false}
        hideHeader
        side={{ recipientName: "Builder" }}
        deliveryIndicator={<DeliveryIndicator block={observation} />}
        contextLink={<span>Source conversation</span>}
      >
        <p>Observation</p>
      </Post>
    </QueryClientProvider>
  );
  expect(screen.getByText("→ Builder")).toBeTruthy();
  expect(screen.getByTestId("chat-delivery-indicator")).toBeTruthy();
  expect(screen.getByTestId("chat-delivery-slot")).toBeTruthy();
  expect(screen.getByText("Source conversation")).toBeTruthy();
  expect(screen.queryByTestId("chat-post-time")).toBeNull();
});
it("keeps uncertain schedule recovery and Manage visible even with details collapsed", () => {
  render(
    <ScheduledMessageEntry
      agentId="a"
      scheduleId="s"
      delivery
      deliveryStatus="uncertain"
      fallbackText="Scheduled message"
      systemEvent={{
        category: "info",
        summary: "Scheduled delivery",
        details: "",
      }}
    />
  );
  const details = screen.getByRole("button", { name: "Details" });
  expect(details.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(details);
  expect(
    screen.getByText("Acceptance unconfirmed · schedule suspended")
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
  fireEvent.click(details);
  expect(screen.queryByText("Observation details")).toBeNull();
  expect(screen.queryByText(/Not merge approval/)).toBeNull();
});

const snapshot = {
  title: "Check CI",
  message: "Look at CI",
  intervalSeconds: 3600,
  expiresAt: "2099-01-02T00:00:00.000Z",
  maxDeliveries: 5,
  deliveredCount: 0,
  nextDueAt: "2000-01-01T10:00:00.000Z",
  status: "active" as const,
};
const reminder = () =>
  render(
    <ScheduledMessageEntry
      agentId="a"
      scheduleId="s"
      delivery={false}
      fallbackText="Scheduled reminder"
      presentation={snapshot}
      systemEvent={{
        category: "info",
        summary: "Scheduled reminder",
        details: "",
      }}
    />
  );
it("shows the live next delivery time on an active reminder", () => {
  const next = new Date(Date.now() + 3_600_000).toISOString();
  live.data = [{ ...snapshot, id: "s", nextDueAt: next }];
  const view = reminder();
  const time = view.container.querySelector(`time[datetime="${next}"]`);
  expect(time?.closest("span")?.textContent).toMatch(/^Next /);
  expect(time?.getAttribute("title")).toBe(new Date(next).toLocaleString());
  expect(screen.queryByText("Active")).toBeNull();
});
it("never presents a frozen snapshot or past time as the next delivery", () => {
  reminder();
  expect(screen.getByText("Active")).toBeTruthy();
  expect(screen.queryByText(/^Next/)).toBeNull();
  cleanup();
  live.data = [{ ...snapshot, id: "s" }];
  reminder();
  expect(screen.getByText("Active")).toBeTruthy();
  expect(screen.queryByText(/Next/)).toBeNull();
});
it("follows the live status once a reminder is cancelled", () => {
  live.data = [
    {
      ...snapshot,
      id: "s",
      status: "cancelled",
      nextDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ];
  reminder();
  expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Next/)).toBeNull();
});
