// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhiteboardData } from "./use-whiteboard";

import { useWhiteboard, whiteboardQueryKey } from "./use-whiteboard";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function board(overrides: Partial<WhiteboardData> = {}): WhiteboardData {
  return {
    scene: { elements: [] },
    version: 1,
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  // restoreAllMocks alone stops resetting module-factory vi.fn() mocks in
  // vitest 3 — reset explicitly so call history and implementations never
  // leak across tests.
  apiMock.mockReset();
});

describe("whiteboardQueryKey", () => {
  it("scopes the cache entry to the agent", () => {
    expect(whiteboardQueryKey("agt_1")).toEqual(["whiteboard", "agt_1"]);
  });
});

describe("useWhiteboard", () => {
  it("fetches the agent's whiteboard from the versioned endpoint", async () => {
    const data = board({ version: 4 });
    apiMock.mockResolvedValueOnce(data);

    const { result } = renderHook(() => useWhiteboard("agt_1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/agents/agt_1/whiteboard");
    expect(result.current.data).toEqual(data);
  });

  it("stays idle without an agent id", () => {
    const { result } = renderHook(() => useWhiteboard(null), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("starts fetching once an agent id arrives", async () => {
    apiMock.mockResolvedValueOnce(board());

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string | null }) => useWhiteboard(agentId),
      { wrapper, initialProps: { agentId: null as string | null } }
    );

    expect(apiMock).not.toHaveBeenCalled();

    rerender({ agentId: "agt_1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/agents/agt_1/whiteboard");
  });

  it("never refetches a cached board on remount (staleTime Infinity)", async () => {
    apiMock.mockResolvedValueOnce(board({ version: 7 }));

    const first = renderHook(() => useWhiteboard("agt_1"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useWhiteboard("agt_1"), { wrapper });
    expect(second.result.current.data).toEqual(board({ version: 7 }));
    // The Excalidraw relay owns updates after the first load; a remount must
    // serve the cache, not re-hit the endpoint.
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("keeps separate cache entries per agent", async () => {
    apiMock.mockResolvedValueOnce(board({ version: 1 }));
    apiMock.mockResolvedValueOnce(board({ version: 2 }));

    const first = renderHook(() => useWhiteboard("agt_1"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    const second = renderHook(() => useWhiteboard("agt_2"), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(first.result.current.data?.version).toBe(1);
    expect(second.result.current.data?.version).toBe(2);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/agents/agt_1/whiteboard"
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/agents/agt_2/whiteboard"
    );
  });
});
