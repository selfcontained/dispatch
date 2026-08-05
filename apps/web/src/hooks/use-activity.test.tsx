// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_RANGES,
  getRangeBounds,
  rangeLabel,
  useActiveHours,
  useActivityHeatmap,
  useActivityStats,
  useAgentsCreated,
  useDailyStatus,
  useTokenByModel,
  useTokenByProject,
  useTokenDaily,
  useTokenStats,
  useWorkingTimeByProject,
  type ActivityRange,
} from "./use-activity";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

// The hook captures the ambient zone at module scope, so assertions are made
// relative to it rather than stubbing TZ (which the module has already read).
const AMBIENT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function calledUrl(callIndex = 0): { path: string; params: URLSearchParams } {
  const url = apiMock.mock.calls[callIndex]?.[0];
  if (typeof url !== "string") {
    throw new Error(`api call ${callIndex} was not made`);
  }
  const [path, query = ""] = url.split("?");
  return { path, params: new URLSearchParams(query) };
}

function localParts(iso: string) {
  const d = new Date(iso);
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    hours: d.getHours(),
    minutes: d.getMinutes(),
    seconds: d.getSeconds(),
    ms: d.getMilliseconds(),
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

describe("rangeLabel", () => {
  it("labels every range", () => {
    expect(ACTIVITY_RANGES.map((r) => rangeLabel(r))).toEqual([
      "Daily",
      "Last 7 days",
      "Last 30 days",
      "This year",
      "All time",
    ]);
  });
});

describe("getRangeBounds", () => {
  const NOW = new Date("2026-08-04T18:30:45.123Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds an explicit daily date to local midnight through next local midnight", () => {
    const { start, end } = getRangeBounds("daily", "2026-03-15");

    expect(localParts(start)).toEqual({
      year: 2026,
      month: 2,
      day: 15,
      hours: 0,
      minutes: 0,
      seconds: 0,
      ms: 0,
    });
    expect(localParts(end)).toEqual({
      year: 2026,
      month: 2,
      day: 16,
      hours: 0,
      minutes: 0,
      seconds: 0,
      ms: 0,
    });
  });

  it("ends a daily range at the next local midnight even across a DST transition", () => {
    // 2026-03-08 is the US spring-forward date (a 23-hour day in US zones).
    // The end bound must land on the next calendar midnight, not start + 24h.
    const { start, end } = getRangeBounds("daily", "2026-03-08");

    expect(localParts(start)).toMatchObject({ month: 2, day: 8, hours: 0 });
    expect(localParts(end)).toMatchObject({ month: 2, day: 9, hours: 0 });
  });

  it("defaults the daily date to today's UTC date parsed as local midnight", () => {
    // Documented quirk: the default day is derived from now.toISOString()
    // (UTC), then parsed as LOCAL midnight. Near the UTC date rollover the
    // default day can differ from the viewer's local date — pin the UTC
    // derivation by picking an instant where the two disagree west of UTC.
    // The UTC-vs-local distinction is only observable when the ambient zone
    // is west of UTC (local date Aug 4 vs UTC date Aug 5); in UTC the two
    // derivations coincide and this test cannot tell them apart.
    vi.setSystemTime(new Date("2026-08-05T03:00:00Z"));

    const { start } = getRangeBounds("daily");

    expect(start).toBe(new Date("2026-08-05T00:00:00").toISOString());
  });

  it("starts the year range at local Jan 1 and ends now", () => {
    const { start, end } = getRangeBounds("year");

    expect(localParts(start)).toEqual({
      year: 2026,
      month: 0,
      day: 1,
      hours: 0,
      minutes: 0,
      seconds: 0,
      ms: 0,
    });
    expect(end).toBe(NOW.toISOString());
  });

  it("computes 7d and 30d as exact rolling windows ending now", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    const week = getRangeBounds("7d");
    expect(week.start).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
    expect(week.end).toBe(NOW.toISOString());

    const month = getRangeBounds("30d");
    expect(month.start).toBe(
      new Date(NOW.getTime() - 30 * DAY_MS).toISOString()
    );
    expect(month.end).toBe(NOW.toISOString());
  });

  it("returns empty bounds for all time", () => {
    expect(getRangeBounds("all")).toEqual({ start: "", end: "" });
  });
});

describe("useActivityStats", () => {
  const stats = {
    totalWorkingMs: 1000,
    avgBlockedMs: 0,
    avgWaitingMs: 0,
    busiestDay: null,
    busiestDayCount: 0,
    stateDurations: {},
  };

  it.each<[ActivityRange, string]>([
    ["daily", "hour"],
    ["7d", "day"],
    ["30d", "day"],
    ["year", "month"],
    ["all", "month"],
  ])("requests %s with granularity=%s", async (range, granularity) => {
    apiMock.mockResolvedValueOnce(stats);

    const { result } = renderHook(() => useActivityStats(range), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { path, params } = calledUrl();
    expect(path).toBe("/api/v1/activity/stats");
    expect(params.get("granularity")).toBe(granularity);
    expect(params.get("tz")).toBe(AMBIENT_TZ);
  });

  it("sends the explicit daily date's local-midnight bounds", async () => {
    apiMock.mockResolvedValueOnce(stats);

    const { result } = renderHook(
      () => useActivityStats("daily", "2026-03-15"),
      {
        wrapper,
      }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { params } = calledUrl();
    expect(params.get("start")).toBe(
      new Date("2026-03-15T00:00:00").toISOString()
    );
    expect(params.get("end")).toBe(
      new Date("2026-03-16T00:00:00").toISOString()
    );
    expect(result.current.data).toEqual(stats);
  });

  it("omits start and end entirely for all time", async () => {
    apiMock.mockResolvedValueOnce(stats);

    const { result } = renderHook(() => useActivityStats("all"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { params } = calledUrl();
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);
  });

  it("caches per range and daily date", async () => {
    apiMock.mockResolvedValueOnce(stats);

    const { result } = renderHook(
      () => useActivityStats("daily", "2026-03-15"),
      {
        wrapper,
      }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData(["activity", "stats", "daily", "2026-03-15"])
    ).toEqual(stats);
  });

  it("refetches on remount even while fresh", async () => {
    apiMock.mockResolvedValue(stats);

    const first = renderHook(() => useActivityStats("all"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useActivityStats("all"), { wrapper });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  });
});

describe("useActivityHeatmap", () => {
  it("requests the heatmap window and unwraps days", async () => {
    const days = [{ day: "2026-08-01", count: 3 }];
    apiMock.mockResolvedValueOnce({ days });

    const { result } = renderHook(() => useActivityHeatmap(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { path, params } = calledUrl();
    expect(path).toBe("/api/v1/activity/heatmap");
    expect(params.get("days")).toBe("365");
    expect(params.get("tz")).toBe(AMBIENT_TZ);
    expect(result.current.data).toEqual(days);
  });

  it("passes a custom day window through to the request and cache key", async () => {
    apiMock.mockResolvedValueOnce({ days: [] });

    const { result } = renderHook(() => useActivityHeatmap(30), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledUrl().params.get("days")).toBe("30");
    expect(queryClient.getQueryData(["activity", "heatmap", 30])).toEqual([]);
  });
});

describe("useActiveHours", () => {
  it("requests raw bounds without granularity and builds the 7x24 grid", async () => {
    // Two events in the same local day-of-week/hour bucket, one in another.
    const base = new Date("2026-08-04T09:15:00");
    const other = new Date("2026-08-04T09:45:00");
    const lone = new Date("2026-08-05T22:05:00");
    apiMock.mockResolvedValueOnce({
      events: [
        { created_at: base.toISOString() },
        { created_at: other.toISOString() },
        { created_at: lone.toISOString() },
      ],
    });

    const { result } = renderHook(() => useActiveHours("all"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { path, params } = calledUrl();
    expect(path).toBe("/api/v1/activity/active-hours");
    expect(params.get("tz")).toBe(AMBIENT_TZ);
    expect(params.has("granularity")).toBe(false);
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);

    const cells = result.current.data ?? [];
    expect(cells).toHaveLength(7 * 24);
    const paired = cells.find(
      (c) => c.dayOfWeek === base.getDay() && c.hour === base.getHours()
    );
    expect(paired?.count).toBe(2);
    const single = cells.find(
      (c) => c.dayOfWeek === lone.getDay() && c.hour === lone.getHours()
    );
    expect(single?.count).toBe(1);
  });

  it("sends daily bounds for an explicit date", async () => {
    apiMock.mockResolvedValueOnce({ events: [] });

    const { result } = renderHook(() => useActiveHours("daily", "2026-03-15"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { params } = calledUrl();
    expect(params.get("start")).toBe(
      new Date("2026-03-15T00:00:00").toISOString()
    );
    expect(params.get("end")).toBe(
      new Date("2026-03-16T00:00:00").toISOString()
    );
  });
});

describe("payload unwrapping", () => {
  it("useTokenByModel unwraps models", async () => {
    const models = [
      {
        model: "claude-fable-5",
        total_input: 1,
        total_cache_creation: 2,
        total_cache_read: 3,
        total_output: 4,
        sessions: 5,
      },
    ];
    apiMock.mockResolvedValueOnce({ models });

    const { result } = renderHook(() => useTokenByModel("all"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledUrl().path).toBe("/api/v1/activity/token-by-model");
    expect(result.current.data).toEqual(models);
  });

  it("useTokenByProject unwraps projects", async () => {
    const projects = [
      { project_dir: "/tmp/a", total_input: 1, total_output: 2, messages: 3 },
    ];
    apiMock.mockResolvedValueOnce({ projects });

    const { result } = renderHook(() => useTokenByProject("all"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledUrl().path).toBe("/api/v1/activity/token-by-project");
    expect(result.current.data).toEqual(projects);
  });

  it("useWorkingTimeByProject unwraps projects", async () => {
    const projects = [{ project_dir: "/tmp/a", working_time_ms: 1234 }];
    apiMock.mockResolvedValueOnce({ projects });

    const { result } = renderHook(() => useWorkingTimeByProject("all"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledUrl().path).toBe("/api/v1/activity/working-time-by-project");
    expect(result.current.data).toEqual(projects);
  });
});

describe("passthrough endpoints", () => {
  type PassthroughHook = (
    range: ActivityRange,
    dailyDate?: string
  ) => { isSuccess: boolean; data: unknown };

  it.each<[string, PassthroughHook, string]>([
    ["useDailyStatus", useDailyStatus, "/api/v1/activity/daily-status"],
    ["useTokenStats", useTokenStats, "/api/v1/activity/token-stats"],
    ["useTokenDaily", useTokenDaily, "/api/v1/activity/token-daily"],
    ["useAgentsCreated", useAgentsCreated, "/api/v1/activity/agents-created"],
  ])(
    "%s hits its endpoint and returns the payload as-is",
    async (_name, useHook, path) => {
      const payload = { marker: "payload" };
      apiMock.mockResolvedValueOnce(payload);

      const { result } = renderHook(() => useHook("7d"), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const call = calledUrl();
      expect(call.path).toBe(path);
      expect(call.params.get("granularity")).toBe("day");
      expect(result.current.data).toEqual(payload);
    }
  );
});
