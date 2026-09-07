// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ResourceWindow,
  ServiceResourcesResponse,
} from "./use-service-resources";

import {
  useServiceResources,
  useSetServiceResourcesCollection,
} from "./use-service-resources";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function response(
  overrides: Partial<ServiceResourcesResponse> = {}
): ServiceResourcesResponse {
  return {
    collectionEnabled: true,
    generatedAt: 1_700_000_000_000,
    processStartedAt: 1_699_999_000_000,
    availableHistoryMs: 900_000,
    sampleIntervalMs: 5_000,
    overall: { state: "healthy", reasons: [] },
    capabilities: {
      processTreeMetrics: "available",
      eventLoopMetrics: "available",
    },
    current: {
      server: {
        cpuPercent: 3,
        rssBytes: 1024,
        heapUsedBytes: 512,
        heapTotalBytes: 1024,
        externalBytes: 64,
        uptimeSeconds: 1000,
      },
      host: {
        load1: 1,
        load5: 1,
        load15: 1,
        cpuCount: 8,
        totalMemoryBytes: 8_192,
        freeMemoryBytes: 4_096,
      },
      agents: {
        supported: true,
        cpuPercent: null,
        rssBytes: null,
        processCount: 0,
        sampledAt: null,
        error: null,
      },
      database: {
        state: "healthy",
        latencyMs: 2,
        sampledAt: 1_700_000_000_000,
        sizeBytes: 12_582_912,
        sizeSampledAt: 1_700_000_000_000,
        pool: { total: 2, idle: 2, waiting: 0, max: 10 },
      },
      eventLoop: { p95DelayMs: 1 },
      http: {
        requestsPerMinute: 10,
        inFlight: 0,
        errorRatePercent: 0,
        p95DurationMs: 5,
      },
      workloads: {
        runningAgents: 0,
        sseClients: 0,
        streams: 0,
        streamViewers: 0,
        terminalObservers: 0,
        terminalViewers: 0,
        scheduledJobs: 0,
        jobMonitors: 0,
        gitRefreshesInFlight: 0,
        uiEventsPublished: 0,
        uiWriteFailures: 0,
        terminalPolls: 0,
        terminalPollFailures: 0,
      },
    },
    subsystems: [],
    series: [
      {
        at: 1_700_000_000_000,
        serverCpuPercent: 3,
        serverRssBytes: 1024,
        serverHeapBytes: 512,
        agentCpuPercent: null,
        agentRssBytes: null,
        hostLoad1: 1,
        subsystems: {},
      },
    ],
    ...overrides,
  };
}

function queryKey(window: ResourceWindow) {
  return ["service-resources", window] as const;
}

/** A promise plus its resolve/reject handles, for driving in-flight requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("useServiceResources", () => {
  it("fetches the requested window and returns the payload", async () => {
    const payload = response();
    apiMock.mockResolvedValueOnce(payload);

    const view = renderHook(() => useServiceResources("15m"), { wrapper });

    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/system/resources?window=15m");
    expect(view.result.current.data).toEqual(payload);
  });

  it("caches each window under its own query key", async () => {
    const fifteen = response({ availableHistoryMs: 900_000 });
    const hour = response({ availableHistoryMs: 3_600_000 });
    apiMock.mockResolvedValueOnce(fifteen).mockResolvedValueOnce(hour);

    const first = renderHook(() => useServiceResources("15m"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useServiceResources("1h"), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(apiMock).toHaveBeenCalledWith("/api/v1/system/resources?window=1h");
    expect(queryClient.getQueryData(queryKey("15m"))).toEqual(fifteen);
    expect(queryClient.getQueryData(queryKey("1h"))).toEqual(hour);
  });

  it("keeps showing the previous payload while a new window loads", async () => {
    const fifteen = response();
    apiMock.mockResolvedValueOnce(fifteen);
    const pending = deferred<ServiceResourcesResponse>();

    const view = renderHook(
      ({ window }: { window: ResourceWindow }) => useServiceResources(window),
      { wrapper, initialProps: { window: "15m" as ResourceWindow } }
    );
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    apiMock.mockReturnValueOnce(pending.promise);
    view.rerender({ window: "1h" });

    expect(view.result.current.data).toEqual(fifteen);
    expect(view.result.current.isPlaceholderData).toBe(true);

    const hour = response({ availableHistoryMs: 3_600_000 });
    pending.resolve(hour);
    await waitFor(() => expect(view.result.current.data).toEqual(hour));
  });
});

describe("useSetServiceResourcesCollection", () => {
  function seedBothWindows() {
    const fifteen = response();
    const hour = response({ availableHistoryMs: 3_600_000 });
    queryClient.setQueryData(queryKey("15m"), fifteen);
    queryClient.setQueryData(queryKey("1h"), hour);
    return { fifteen, hour };
  }

  it("POSTs the enabled flag to the settings endpoint", async () => {
    apiMock.mockResolvedValueOnce({ collectionEnabled: false });

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(false));

    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/system/resources/settings",
      expect.objectContaining({ method: "POST" })
    );
    const init = apiMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
  });

  it("optimistically clears history on disable across every window", async () => {
    seedBothWindows();
    const pending = deferred<{ collectionEnabled: boolean }>();
    apiMock.mockReturnValueOnce(pending.promise);

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(false));

    await waitFor(() => {
      for (const window of ["15m", "1h"] as const) {
        const data = queryClient.getQueryData<ServiceResourcesResponse>(
          queryKey(window)
        );
        expect(data?.collectionEnabled).toBe(false);
        expect(data?.series).toEqual([]);
        expect(data?.availableHistoryMs).toBe(0);
      }
    });

    pending.resolve({ collectionEnabled: false });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  });

  it("optimistically enables without discarding existing history", async () => {
    const { fifteen } = seedBothWindows();
    queryClient.setQueryData(queryKey("15m"), {
      ...fifteen,
      collectionEnabled: false,
    });
    const pending = deferred<{ collectionEnabled: boolean }>();
    apiMock.mockReturnValueOnce(pending.promise);

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(true));

    await waitFor(() => {
      const data = queryClient.getQueryData<ServiceResourcesResponse>(
        queryKey("15m")
      );
      expect(data?.collectionEnabled).toBe(true);
    });
    const data = queryClient.getQueryData<ServiceResourcesResponse>(
      queryKey("15m")
    );
    expect(data?.series).toEqual(fifteen.series);
    expect(data?.availableHistoryMs).toBe(fifteen.availableHistoryMs);

    pending.resolve({ collectionEnabled: true });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  });

  it("leaves an empty cache empty instead of fabricating an entry", async () => {
    const pending = deferred<{ collectionEnabled: boolean }>();
    apiMock.mockReturnValueOnce(pending.promise);

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(false));

    await waitFor(() => expect(view.result.current.isPending).toBe(true));
    expect(queryClient.getQueryData(queryKey("15m"))).toBeUndefined();

    pending.resolve({ collectionEnabled: false });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  });

  it("rolls back every window's snapshot when the POST fails", async () => {
    const { fifteen, hour } = seedBothWindows();
    const pending = deferred<{ collectionEnabled: boolean }>();
    apiMock.mockReturnValueOnce(pending.promise);

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(false));

    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServiceResourcesResponse>(queryKey("15m"))
          ?.series
      ).toEqual([])
    );

    pending.reject(new Error("save failed"));
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(queryClient.getQueryData(queryKey("15m"))).toEqual(fifteen);
    expect(queryClient.getQueryData(queryKey("1h"))).toEqual(hour);
  });

  it("invalidates resource queries after settling so the server truth wins", async () => {
    seedBothWindows();
    apiMock.mockResolvedValueOnce({ collectionEnabled: false });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const view = renderHook(() => useSetServiceResourcesCollection(), {
      wrapper,
    });
    act(() => view.result.current.mutate(false));

    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["service-resources"],
      })
    );
  });
});
