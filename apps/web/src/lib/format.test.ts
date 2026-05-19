import { describe, expect, it, vi, afterEach } from "vitest";

import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
  formatRelativeTime,
} from "./format";

describe("formatDuration", () => {
  it("returns 0s for sub-second values", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
  });

  it("returns seconds for < 60s", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("returns minutes for < 60m", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_540_000)).toBe("59m");
  });

  it("returns hours with remainder minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("returns days with remainder hours", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("formatTokenCount", () => {
  it("returns raw number below 1K", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("returns K notation for thousands", () => {
    expect(formatTokenCount(1_000)).toBe("1.0K");
    expect(formatTokenCount(1_500)).toBe("1.5K");
    expect(formatTokenCount(999_999)).toBe("1000.0K");
  });

  it("returns M notation for millions", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

describe("shortProjectName", () => {
  it("returns short paths unchanged", () => {
    expect(shortProjectName("myproject")).toBe("myproject");
    expect(shortProjectName("a/b")).toBe("a/b");
  });

  it("returns last two segments for long paths", () => {
    expect(shortProjectName("/Users/brad/dev/dispatch")).toBe("dev/dispatch");
  });

  it("strips trailing slash before splitting", () => {
    expect(shortProjectName("/Users/brad/dev/dispatch/")).toBe("dev/dispatch");
  });
});

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for invalid ISO", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("returns 'just now' for recent timestamps", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z") });
    expect(formatRelativeTime("2026-01-01T00:00:00Z")).toBe("just now");
  });

  it("returns minutes ago", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:05:00Z") });
    expect(formatRelativeTime("2026-01-01T00:00:00Z")).toBe("5m ago");
  });

  it("returns hours ago", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T03:00:00Z") });
    expect(formatRelativeTime("2026-01-01T00:00:00Z")).toBe("3h ago");
  });

  it("returns days ago", () => {
    vi.useFakeTimers({ now: new Date("2026-01-05T00:00:00Z") });
    expect(formatRelativeTime("2026-01-01T00:00:00Z")).toBe("4d ago");
  });

  it("returns formatted date for 30+ days", () => {
    vi.useFakeTimers({ now: new Date(2026, 2, 1) });
    const iso = new Date(2026, 0, 15).toISOString();
    const result = formatRelativeTime(iso);
    expect(result).toContain("Jan");
  });
});
