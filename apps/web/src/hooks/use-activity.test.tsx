// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_RANGES,
  getRangeBounds,
  rangeLabel,
  useTokenByModel,
  useTokenByProject,
  useTokenDaily,
  useTokenStats,
  type ActivityRange,
} from "./use-activity";

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
});

describe("passthrough endpoints", () => {
  type PassthroughHook = (
    range: ActivityRange,
    dailyDate?: string
  ) => { isSuccess: boolean; data: unknown };

  it.each<[string, PassthroughHook, string]>([
    ["useTokenStats", useTokenStats, "/api/v1/activity/token-stats"],
    ["useTokenDaily", useTokenDaily, "/api/v1/activity/token-daily"],
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
