// @vitest-environment jsdom
import { cleanup, act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockDelivery } from "@dispatch/shared";
import { block } from "@/test-utils/blocks";
import { DeliveryIndicator, DeliveryMeta } from "./chat-delivery-meta";

const waiting: BlockDelivery = {
  agentId: "agt_1",
  state: "delivered",
  receipt: { pickedUpAt: null, deliveredAt: "2026-09-25T20:00:00Z" },
};
const received: BlockDelivery = {
  ...waiting,
  receipt: { ...waiting.receipt, pickedUpAt: "2026-09-25T20:00:01Z" },
};
const name = (id: string) => id;
function receipt(delivery: BlockDelivery[]) {
  return block({ id: "receipt", authorKind: "user", delivery });
}
function ui(delivery: BlockDelivery[]) {
  return (
    <>
      <DeliveryMeta block={receipt(delivery)} recipientName={name} />
      <DeliveryIndicator block={receipt(delivery)} />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("quiet delivery status", () => {
  it("shows waiting, briefly confirms a new receipt, and keeps reload quiet", () => {
    vi.useFakeTimers();
    const view = render(ui([waiting]));
    expect(screen.getByTestId("chat-receipt-sent")).toBeTruthy();
    view.rerender(ui([received]));
    expect(screen.queryByTestId("chat-receipt-sent")).toBeNull();
    expect(screen.getByTestId("chat-receipt-received")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.queryByTestId("chat-receipt-received")).toBeNull();
    view.unmount();
    render(ui([received]));
    expect(screen.queryByTestId("chat-receipt-received")).toBeNull();
  });
  it("suppresses fast sends and keeps queued/failed states visible", () => {
    vi.useFakeTimers();
    const view = render(ui([{ agentId: "agt_1", state: "pending" }]));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByTestId("chat-delivery-pending")).toBeTruthy();
    view.rerender(ui([{ agentId: "agt_1", state: "held" }]));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId("chat-held-hint")).toBeTruthy();
    view.rerender(ui([{ agentId: "agt_1", state: "failed" }]));
    expect(screen.getByTestId("chat-delivery-failed")).toBeTruthy();
  });
  it("does not erase other recipients or replay a receipt on unrelated updates", () => {
    vi.useFakeTimers();
    const other: BlockDelivery = { ...waiting, agentId: "agt_2" };
    const view = render(ui([waiting, other]));
    view.rerender(ui([received, other]));
    expect(screen.queryByTestId("chat-receipt-received")).toBeNull();
    expect(
      screen.getByTestId("chat-delivery-indicator").getAttribute("aria-label")
    ).toBe("Sent · 1 of 2 agents received it");
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.getByTestId("chat-receipt-sent")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2100));
    view.rerender(ui([received, { agentId: "agt_2", state: "failed" }]));
    expect(screen.queryByTestId("chat-receipt-received")).toBeNull();
    expect(screen.getByTestId("chat-delivery-failed")).toBeTruthy();
    view.rerender(ui([{ agentId: "agt_1", state: "pending" }]));
    expect(screen.queryByTestId("chat-receipt-sent")).toBeNull();
  });
  it("has no button or popover, and keeps the same slot after a receipt fades", () => {
    vi.useFakeTimers();
    const view = render(ui([waiting]));
    const indicator = screen.getByTestId("chat-delivery-indicator");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(ui([received]));
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.getByTestId("chat-delivery-indicator")).toBe(indicator);
    expect(indicator.className).toContain("opacity-0");
  });
});
