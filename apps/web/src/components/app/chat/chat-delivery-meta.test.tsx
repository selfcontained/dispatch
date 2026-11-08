// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, type ReactNode } from "react";
import {
  cleanup,
  act,
  render as testingRender,
  screen,
  fireEvent,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockDelivery } from "@dispatch/shared";
import { block } from "@/test-utils/blocks";
import { DeliveryIndicator, DeliveryMeta } from "./chat-delivery-meta";

const clients: QueryClient[] = [];
function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
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
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});
describe("quiet delivery status", () => {
  it("distinguishes requested interruption from confirmation and offers explicit retry on failure", () => {
    const retry = vi.fn();
    const post = block({
      id: "urgent",
      authorKind: "user",
      body: { kind: "text", data: { delivery: "interrupt" }, state: null },
      delivery: [{ agentId: "agt_1", state: "held" }],
    });
    const view = render(
      <DeliveryMeta block={post} recipientName={name} onRetryDelivery={retry} />
    );
    expect(screen.getByTestId("chat-held-hint").textContent).toBe(
      "Stop requested"
    );
    expect(screen.getByTestId("chat-held-hint").title).toContain(
      "may take time to cancel"
    );
    view.rerender(
      <DeliveryMeta
        block={{ ...post, delivery: [{ agentId: "agt_1", state: "failed" }] }}
        recipientName={name}
        onRetryDelivery={retry}
      />
    );
    expect(screen.getByTestId("chat-delivery-failed").textContent).toContain(
      "Interrupt failed"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try interrupt again" })
    );
    expect(retry).toHaveBeenCalledWith("urgent");
    view.rerender(
      <DeliveryMeta
        block={{ ...post, delivery: [waiting] }}
        recipientName={name}
      />
    );
    expect(screen.queryByTestId("chat-held-hint")).toBeNull();
  });

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

describe("routing in the existing SSE-only receipt slot", () => {
  it("waits500ms, reuses the receipt mark and clears on completion without fetching", async () => {
    vi.useFakeTimers();
    const post = block({
      id: "routing-user",
      streamId: "stream",
      author: { kind: "user" },
      toAgentId: "agt_1",
      createdAt: new Date().toISOString(),
      delivery: [waiting],
    });
    render(<DeliveryIndicator block={post} />);
    const client = clients[clients.length - 1];
    const mark = screen.getByTestId("chat-delivery-indicator");
    expect(mark.getAttribute("data-status")).toBe("Sent");
    const beforeQueries = client.getQueryCache().getAll().length;
    act(() =>
      client.setQueryData(["routing-pending", "stream"], {
        pending: [
          {
            turnId: 1,
            agentId: "agt_1",
            streamId: "stream",
            threadId: null,
            messageIds: [post.id],
            startedAt: Date.now(),
            deadlineAt: Date.now() + 3000,
          },
        ],
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mark.getAttribute("data-status")).toBe("Sent");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mark.getAttribute("data-status")).toBe("Choosing reply location");
    expect(mark.className).toContain("h-4 w-4");
    expect(mark.className).toContain("motion-reduce:transition-none");
    act(() =>
      client.setQueryData(["routing-pending", "stream"], { pending: [] })
    );
    expect(screen.getByTestId("chat-delivery-indicator")).toBe(mark);
    expect(mark.getAttribute("data-status")).toBe("Sent");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(client.getQueryCache().getAll()).toHaveLength(beforeQueries + 1);
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((q) => q.getObserversCount() === 0)
    ).toBe(true);
  });
  it("suppresses fast routing and expires missing completion without a row or HTTP query", async () => {
    vi.useFakeTimers();
    const post = block({
      id: "fast",
      streamId: "stream",
      author: { kind: "user" },
      createdAt: new Date().toISOString(),
    });
    render(<DeliveryIndicator block={post} />);
    const client = clients[clients.length - 1];
    const pending = {
      turnId: 1,
      agentId: "agt_1",
      streamId: "stream",
      threadId: null,
      messageIds: [post.id],
      startedAt: Date.now(),
      deadlineAt: Date.now() + 3000,
    };
    act(() =>
      client.setQueryData(["routing-pending", "stream"], {
        pending: [pending],
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() =>
      client.setQueryData(["routing-pending", "stream"], { pending: [] })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByLabelText("Choosing reply location")).toBeNull();
    act(() =>
      client.setQueryData(["routing-pending", "stream"], {
        pending: [
          {
            ...pending,
            turnId: 2,
            startedAt: Date.now(),
            deadlineAt: Date.now() + 3000,
          },
        ],
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByLabelText("Choosing reply location")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByLabelText("Choosing reply location")).toBeNull();
  });
  it("shows routing for an old queued message when its actual routing begins later", async () => {
    vi.useFakeTimers();
    const post = block({
      id: "old-queued",
      streamId: "stream",
      author: { kind: "user" },
      createdAt: new Date(Date.now() - 60000).toISOString(),
      delivery: [{ agentId: "agt_1", state: "held" }],
    });
    render(<DeliveryIndicator block={post} />);
    const client = clients[clients.length - 1];
    act(() =>
      client.setQueryData(["routing-pending", "stream"], {
        pending: [
          {
            turnId: 3,
            agentId: "agt_1",
            streamId: "stream",
            threadId: null,
            messageIds: [post.id],
            startedAt: Date.now(),
            deadlineAt: Date.now() + 3000,
          },
        ],
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByLabelText("Choosing reply location")).not.toBeNull();
  });
});

it("old history receipts have no timers and ignore other messages' pending cache updates", async () => {
  vi.useFakeTimers();
  const post = block({
    id: "old-history",
    streamId: "stream",
    author: { kind: "user" },
    createdAt: new Date(Date.now() - 60000).toISOString(),
    delivered: true,
    delivery: [],
  });
  const commits = vi.fn();
  render(
    <Profiler id="receipt" onRender={commits}>
      <DeliveryIndicator block={post} />
    </Profiler>
  );
  const client = clients[clients.length - 1];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.getTimerCount()).toBe(0);
  commits.mockClear();
  act(() =>
    client.setQueryData(["routing-pending", "stream"], {
      pending: [
        {
          turnId: 4,
          agentId: "agt_1",
          streamId: "stream",
          threadId: null,
          messageIds: ["somebody-else"],
          startedAt: Date.now(),
          deadlineAt: Date.now() + 3000,
        },
      ],
    })
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(commits).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByLabelText("Choosing reply location")).toBeNull();
});
