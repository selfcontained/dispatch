// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoutingDiagnostic, RoutingPending } from "@dispatch/shared";
import { block } from "@/test-utils/blocks";
import { api } from "@/lib/api";
import { RoutingMetadata } from "./routing-metadata";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
let client: QueryClient;
const opener = block({
  id: "opener",
  streamId: "stream",
  author: { kind: "user" },
  toAgentId: "agent",
});
const pending = (): RoutingPending => ({
  turnId: 1,
  agentId: "agent",
  streamId: "stream",
  threadId: null,
  messageIds: ["opener"],
  startedAt: Date.now(),
  deadlineAt: Date.now() + 3000,
});
const result: RoutingDiagnostic = {
  turnId: 1,
  agentId: "agent",
  mode: "active",
  status: "ok",
  actual: "Root",
  reason: "Recommendation applied",
  choice: "home_root",
  probabilities: [],
  costUsd: null,
  costBasis: "unknown",
};
beforeEach(() => {
  vi.useFakeTimers();
  onlineManager.setOnline(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  apiMock.mockReset().mockResolvedValue({ pending: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
function show() {
  return render(
    <QueryClientProvider client={client}>
      <RoutingMetadata block={opener} agentName={() => "Agent"} />
      <RoutingMetadata
        block={{ ...opener, id: "other" }}
        agentName={() => "Agent"}
      />
    </QueryClientProvider>
  );
}
it("takes one snapshot per stream and makes no recurring fetches while idle or pending", async () => {
  show();
  await tick();
  expect(apiMock).toHaveBeenCalledTimes(1);
  expect(apiMock.mock.calls[0][0]).toContain("/routing/pending?");
  await tick(60_000);
  expect(apiMock).toHaveBeenCalledTimes(1);
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [pending()] })
  );
  await tick(299);
  expect(screen.queryByRole("status")).toBeNull();
  await tick(1);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status").className).not.toMatch(
    /absolute|animate|bottom-/
  );
  await tick(3000);
  expect(screen.queryByRole("status")).toBeNull();
  expect(apiMock).toHaveBeenCalledTimes(1);
});
it("uses the same metadata slot for SSE pending then retained decision and clears on config/route/error/offline", async () => {
  const view = show();
  await tick();
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [pending()] })
  );
  await tick();
  await tick(300);
  expect(screen.queryByRole("status")).not.toBeNull();
  act(() => onlineManager.setOnline(false));
  await tick();
  expect(screen.queryByRole("status")).toBeNull();
  act(() => onlineManager.setOnline(true));
  await tick();
  expect(screen.queryByRole("status")).not.toBeNull();
  apiMock.mockRejectedValue(new Error("snapshot unavailable"));
  await act(async () => {
    await client.refetchQueries({ queryKey: ["routing-pending", "stream"] });
  });
  await tick();
  expect(screen.queryByRole("status")).toBeNull();
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [] })
  );
  view.rerender(
    <QueryClientProvider client={client}>
      <RoutingMetadata
        block={{ ...opener, routing: [result] }}
        agentName={() => "Agent"}
      />
    </QueryClientProvider>
  );
  await tick();
  expect(
    screen.getByRole("button", { name: "Routing details: Root" })
  ).toBeTruthy();
  view.rerender(
    <QueryClientProvider client={client}>
      <RoutingMetadata
        block={{ ...opener, streamId: "different" }}
        agentName={() => "Agent"}
      />
    </QueryClientProvider>
  );
  await tick();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
it("does not flash pending for fast completions or revive expired entries on remount", async () => {
  const view = show();
  await tick();
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [pending()] })
  );
  await tick(100);
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [] })
  );
  await tick(500);
  expect(screen.queryByRole("status")).toBeNull();
  const old = {
    ...pending(),
    startedAt: Date.now() - 4000,
    deadlineAt: Date.now() - 1000,
  };
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [old] })
  );
  view.unmount();
  show();
  await tick(500);
  expect(screen.queryByRole("status")).toBeNull();
});
it("refreshes inactive pending invalidated on reconnect when mounted, without refetching fresh mounts", async () => {
  const view = show();
  await tick();
  expect(apiMock).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() =>
    client.setQueryData(["routing-pending", "stream"], { pending: [pending()] })
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["routing-pending"] });
  });
  const remount = show();
  await tick();
  expect(apiMock).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(["routing-pending", "stream"])).toEqual({
    pending: [],
  });
  remount.unmount();
  show();
  await tick();
  expect(apiMock).toHaveBeenCalledTimes(2);
});
it("never lets an expired pending snapshot suppress a completed diagnostic", async () => {
  act(() =>
    client.setQueryData(["routing-pending", "stream"], {
      pending: [
        {
          ...pending(),
          startedAt: Date.now() - 4000,
          deadlineAt: Date.now() - 1000,
        },
      ],
    })
  );
  render(
    <QueryClientProvider client={client}>
      <RoutingMetadata
        block={{ ...opener, routing: [result] }}
        agentName={() => "Agent"}
      />
    </QueryClientProvider>
  );
  await tick();
  expect(
    screen.getByRole("button", { name: "Routing details: Root" })
  ).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});
