// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  harnessQueueQueryKey,
  useHarnessInterrupt,
  useHarnessQueue,
  useHarnessQueued,
} from "./use-harness-queue";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function freshClient() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return vi.spyOn(client, "invalidateQueries");
}

afterEach(() => {
  api.mockReset();
  vi.restoreAllMocks();
});

describe("useHarnessQueued", () => {
  it("reads the queue route and hands back what waits", async () => {
    freshClient();
    api.mockResolvedValue({
      queued: [
        {
          id: "q1",
          source: "chat",
          text: "next please",
          attachments: [],
          createdAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    });
    const { result } = renderHook(() => useHarnessQueued("agt_1"), { wrapper });
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/queue");
    expect(result.current.queued[0].text).toBe("next please");
  });

  it("asks nothing without an agent", () => {
    freshClient();
    const { result } = renderHook(() => useHarnessQueued(null), { wrapper });
    expect(result.current.queued).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("queue actions", () => {
  it("invalidates the queue key after send now", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessQueue("agt_1"), { wrapper });
    await act(async () => {
      await result.current.sendNow("q1");
    });
    expect(api).toHaveBeenCalledWith(
      "/api/v1/agents/agt_1/harness/queue/q1/send-now",
      { method: "POST" }
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });

  it("invalidates the queue key after a removal", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessQueue("agt_1"), { wrapper });
    await act(async () => {
      await result.current.remove("q1");
    });
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/queue/q1", {
      method: "DELETE",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });

  it("invalidates the queue key after Stop", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessInterrupt("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.interrupt();
    });
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/interrupt", {
      method: "POST",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });
});
