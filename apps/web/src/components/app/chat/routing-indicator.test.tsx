// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutingIndicator } from "./routing-indicator";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
const settingsKey = ["routing-experiment-settings"];
const pendingKey = ["routing-pending", "agent-1"];
const status = () =>
  screen.queryByRole("status", { name: "Choosing reply location" });
let client: QueryClient;
let pending: {
  pending: {
    turnId: number;
    streamId: string;
    threadId: null;
    startedAt: number;
  }[];
};
beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  pending = {
    pending: [
      {
        turnId: 11,
        streamId: "agent-1",
        threadId: null,
        startedAt: Date.now() - 500,
      },
    ],
  };
  client.setQueryData(settingsKey, { mode: "active", configured: true });
  client.setQueryData(pendingKey, pending);
  apiMock.mockReset().mockResolvedValue(pending);
});
afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
});
async function show() {
  const view = render(
    <QueryClientProvider client={client}>
      <RoutingIndicator streamId="agent-1" />
    </QueryClientProvider>
  );
  await waitFor(() => expect(status()).not.toBeNull());
  return view;
}
describe("RoutingIndicator stale pending state", () => {
  it("clears cached pending when the key is removed while mode remains active", async () => {
    await show();
    act(() => {
      client.setQueryData(settingsKey, { mode: "active", configured: false });
    });
    expect(client.getQueryData(pendingKey)).toEqual(pending);
    await waitFor(() => expect(status()).toBeNull());
  });
  it("hides retained pending data when its next poll fails", async () => {
    await show();
    apiMock.mockRejectedValue(new Error("offline request"));
    await act(async () => {
      await client.refetchQueries({ queryKey: pendingKey, exact: true });
    });
    expect(client.getQueryData(pendingKey)).toEqual(pending);
    await waitFor(() => expect(status()).toBeNull());
  });
  it("hides pending data while polling is paused", async () => {
    await show();
    act(() => {
      client
        .getQueryCache()
        .find({ queryKey: pendingKey, exact: true })!
        .setState({ fetchStatus: "paused" });
    });
    await waitFor(() => expect(status()).toBeNull());
    expect(client.getQueryData(pendingKey)).toEqual(pending);
  });
  it("hides immediately when offline, even before the next poll", async () => {
    await show();
    act(() => onlineManager.setOnline(false));
    await waitFor(() => expect(status()).toBeNull());
    expect(client.getQueryData(pendingKey)).toEqual(pending);
  });
  it("expires an otherwise successful cached row at the server routing deadline", async () => {
    pending.pending[0]!.startedAt = Date.now() - 2700;
    client.setQueryData(pendingKey, pending);
    await show();
    await waitFor(() => expect(status()).toBeNull());
    expect(client.getQueryData(pendingKey)).toEqual(pending);
  });
  it("does not revive an already expired cached row on remount", async () => {
    pending.pending[0]!.startedAt = Date.now() - 4000;
    client.setQueryData(pendingKey, pending);
    const view = render(
      <QueryClientProvider client={client}>
        <RoutingIndicator streamId="agent-1" />
      </QueryClientProvider>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await waitFor(() => expect(status()).toBeNull());
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <RoutingIndicator streamId="agent-1" />
      </QueryClientProvider>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await waitFor(() => expect(status()).toBeNull());
  });
});
