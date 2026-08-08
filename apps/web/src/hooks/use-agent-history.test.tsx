// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useHistoryAgentDetail,
  useHistoryAgents,
  useHistoryProjects,
  type HistoryAgentsResponse,
  type HistoryFilters,
} from "./use-agent-history";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function calledUrl(callIndex = 0): { path: string; params: URLSearchParams } {
  const url = apiMock.mock.calls[callIndex]?.[0];
  if (typeof url !== "string") {
    throw new Error(`api call ${callIndex} was not made`);
  }
  const [path, query = ""] = url.split("?");
  return { path, params: new URLSearchParams(query) };
}

function makeFilters(overrides: Partial<HistoryFilters> = {}): HistoryFilters {
  return {
    search: "",
    type: "",
    project: "",
    range: "all",
    sort: "createdAt",
    order: "desc",
    offset: 0,
    ...overrides,
  };
}

const emptyResponse: HistoryAgentsResponse = {
  agents: [],
  total: 0,
  limit: 50,
  offset: 0,
};

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

describe("useHistoryProjects", () => {
  it("requests the projects endpoint and unwraps projects", async () => {
    const projects = ["/tmp/a", "/tmp/b"];
    apiMock.mockResolvedValueOnce({ projects });

    const { result } = renderHook(() => useHistoryProjects(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledUrl().path).toBe("/api/v1/history/projects");
    expect(result.current.data).toEqual(projects);
    expect(queryClient.getQueryData(["history", "projects"])).toEqual(projects);
  });

  it("serves a fresh remount from cache without refetching", async () => {
    apiMock.mockResolvedValue({ projects: [] });

    const first = renderHook(() => useHistoryProjects(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useHistoryProjects(), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

describe("useHistoryAgents", () => {
  it("sends only sort, order, and limit for empty all-time filters", async () => {
    apiMock.mockResolvedValueOnce(emptyResponse);

    const { result } = renderHook(() => useHistoryAgents(makeFilters()), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { path, params } = calledUrl();
    expect(path).toBe("/api/v1/history/agents");
    expect(params.get("sort")).toBe("createdAt");
    expect(params.get("order")).toBe("desc");
    expect(params.get("limit")).toBe("50");
    expect(params.has("search")).toBe(false);
    expect(params.has("type")).toBe(false);
    expect(params.has("project")).toBe(false);
    expect(params.has("offset")).toBe(false);
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);
    expect(result.current.data).toEqual(emptyResponse);
  });

  it("passes search, type, project, and a positive offset through", async () => {
    apiMock.mockResolvedValueOnce(emptyResponse);

    const { result } = renderHook(
      () =>
        useHistoryAgents(
          makeFilters({
            search: "deploy agent",
            type: "claude",
            project: "/tmp/proj",
            sort: "totalTokens",
            order: "asc",
            offset: 100,
          })
        ),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { params } = calledUrl();
    expect(params.get("search")).toBe("deploy agent");
    expect(params.get("type")).toBe("claude");
    expect(params.get("project")).toBe("/tmp/proj");
    expect(params.get("sort")).toBe("totalTokens");
    expect(params.get("order")).toBe("asc");
    expect(params.get("offset")).toBe("100");
  });

  it("sends the exact rolling 7d window from getRangeBounds", async () => {
    apiMock.mockResolvedValueOnce(emptyResponse);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const before = Date.now();

    const { result } = renderHook(
      () => useHistoryAgents(makeFilters({ range: "7d" })),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { params } = calledUrl();
    const start = Date.parse(params.get("start") ?? "");
    const end = Date.parse(params.get("end") ?? "");
    expect(end - start).toBe(7 * DAY_MS);
    // The window ends "now" as of queryFn execution time.
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(Date.now());
  });

  it("caches per filters value and refetches when filters change", async () => {
    apiMock.mockResolvedValue(emptyResponse);
    const base = makeFilters();

    const { result, rerender } = renderHook(
      ({ filters }: { filters: HistoryFilters }) => useHistoryAgents(filters),
      { wrapper, initialProps: { filters: base } }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["history", "agents", base])).toEqual(
      emptyResponse
    );

    const paged = makeFilters({ offset: 50 });
    rerender({ filters: paged });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(calledUrl(1).params.get("offset")).toBe("50");

    // Re-rendering with an equal-by-value filters object stays on the cache;
    // a structurally-changed key would start a new fetch synchronously.
    rerender({ filters: makeFilters({ offset: 50 }) });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});

describe("useHistoryAgentDetail", () => {
  it("does not fetch while agentId is null", async () => {
    const { result } = renderHook(() => useHistoryAgentDetail(null), {
      wrapper,
    });

    // Flush pending microtasks so a wrongly-enabled query would have fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fetches the detail endpoint once an agentId is provided", async () => {
    const detail = { agent: { id: "agt_1" }, events: [] };
    apiMock.mockResolvedValueOnce(detail);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useHistoryAgentDetail(id),
      { wrapper, initialProps: { id: null as string | null } }
    );

    expect(result.current.fetchStatus).toBe("idle");
    rerender({ id: "agt_1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(calledUrl().path).toBe("/api/v1/history/agents/agt_1");
    expect(result.current.data).toEqual(detail);
    expect(queryClient.getQueryData(["history", "agent", "agt_1"])).toEqual(
      detail
    );
  });

  it("serves a fresh remount from cache without refetching", async () => {
    apiMock.mockResolvedValue({ agent: { id: "agt_2" } });

    const first = renderHook(() => useHistoryAgentDetail("agt_2"), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useHistoryAgentDetail("agt_2"), {
      wrapper,
    });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
