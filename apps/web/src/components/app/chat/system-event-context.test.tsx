// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Post } from "./chat-entries";
import { DeliveryIndicator } from "./chat-delivery-meta";
import { block } from "@/test-utils/blocks";
import { ScheduledMessageEntry } from "./scheduled-message-entry";
vi.mock("../scheduled-messages", async (original) => ({
  ...(await original<object>()),
  useScheduledMessages: () => ({ data: [] }),
}));
vi.mock("../scheduled-messages-button", () => ({
  ScheduledMessagesButton: () => <button>Manage</button>,
}));
afterEach(cleanup);
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
