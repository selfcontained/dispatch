import { describe, expect, it, vi, afterEach } from "vitest";

import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
  shortPath,
  formatRelativeTime,
  formatDateTime,
  formatShortDateTime,
  formatShortDate,
} from "./format";

describe("shortPath", () => {
  it("returns paths with three or fewer segments unchanged", () => {
    expect(shortPath("/a/b/c")).toBe("/a/b/c");
    expect(shortPath("a/b")).toBe("a/b");
    expect(shortPath("")).toBe("");
  });

  it("keeps only the last three segments of longer paths", () => {
    expect(shortPath("/Users/brad/dev/apps/dispatch")).toBe(
      ".../dev/apps/dispatch"
    );
    expect(shortPath("a/b/c/d")).toBe(".../b/c/d");
  });

  it("counts segments ignoring empty ones, returning short originals verbatim", () => {
    expect(shortPath("/a//b/c/")).toBe("/a//b/c/");
    expect(shortPath("/a/b/c/d//")).toBe(".../b/c/d");
  });
});

describe("formatDuration", () => {
  it("returns n/a for null or undefined", () => {
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(undefined)).toBe("n/a");
  });

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

  it("clamps future timestamps to 'just now'", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    expect(formatRelativeTime("2026-01-01T00:10:00Z")).toBe("just now");
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

describe("formatDateTime", () => {
  it("includes date and time parts", () => {
    const result = formatDateTime("2026-03-15T14:30:00Z");
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/:/);
  });

  it("produces different output for different timestamps", () => {
    const a = formatDateTime("2026-01-01T00:00:00Z");
    const b = formatDateTime("2026-06-15T12:00:00Z");
    expect(a).not.toBe(b);
  });
});

describe("formatShortDateTime", () => {
  it("contains the day number", () => {
    const result = formatShortDateTime("2026-06-15T09:15:00Z");
    expect(result).toMatch(/15/);
  });

  it("produces different output for different months", () => {
    const jan = formatShortDateTime("2026-01-15T09:00:00Z");
    const jun = formatShortDateTime("2026-06-15T09:00:00Z");
    expect(jan).not.toBe(jun);
  });
});

describe("formatShortDate", () => {
  it("contains the day number", () => {
    const result = formatShortDate("2026-01-15");
    expect(result).toMatch(/15/);
  });

  it("does not shift dates due to timezone offset", () => {
    const result = formatShortDate("2026-12-31");
    expect(result).toMatch(/31/);
  });

  it("produces different output for different months", () => {
    const jan = formatShortDate("2026-01-15");
    const dec = formatShortDate("2026-12-15");
    expect(jan).not.toBe(dec);
  });
});
