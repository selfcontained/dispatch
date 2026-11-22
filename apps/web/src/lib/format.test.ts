import { describe, expect, it, vi, afterEach } from "vitest";

import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
  shortPath,
  formatRelativeTime,
  formatRelativeCompact,
  formatTimeUntil,
  formatDayTime,
  formatLatency,
  formatCount,
  formatLongDate,
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

describe("invalid dates", () => {
  it("render as Invalid Date instead of throwing", () => {
    for (const bad of ["", "not-a-date", "null"]) {
      expect(formatDateTime(bad)).toBe("Invalid Date");
      expect(formatShortDateTime(bad)).toBe("Invalid Date");
      expect(formatShortDate(bad)).toBe("Invalid Date");
    }
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

describe("formatRelativeCompact", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [-5 * 60_000, "now", "just now"],
    [59_999, "now", "just now"],
    [60_000, "1m", "1m ago"],
    [59 * 60_000, "59m", "59m ago"],
    [60 * 60_000, "1h", "1h ago"],
    [24 * 3_600_000, "1d", "1d ago"],
    [29 * 86_400_000, "29d", "29d ago"],
  ])("shares its units with the long form at %ims", (ago, compact, long) => {
    vi.useFakeTimers({ now: new Date("2026-06-01T00:00:00Z") });
    const iso = new Date(Date.now() - ago).toISOString();
    expect(formatRelativeCompact(iso)).toBe(compact);
    expect(formatRelativeTime(iso)).toBe(long);
  });

  it("keeps counting days where the long form switches to a date", () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1) });
    const iso = new Date(2026, 3, 1).toISOString();
    expect(formatRelativeCompact(iso)).toBe("61d");
    expect(formatRelativeTime(iso)).toContain("Apr");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatRelativeCompact("not-a-date")).toBe("");
  });
});

describe("formatCount", () => {
  it("groups digits and pluralizes the noun", () => {
    expect(formatCount(1234)).toBe(new Intl.NumberFormat().format(1234));
    expect(formatCount(0, "file")).toBe("0 files");
    expect(formatCount(1, "file")).toBe("1 file");
    expect(formatCount(2, "file")).toBe("2 files");
  });
});

describe("formatLatency", () => {
  it("rounds to whole milliseconds and dashes a missing value", () => {
    expect(formatLatency(12.6)).toBe("13 ms");
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(null)).toBe("—");
  });
});

describe("formatLongDate", () => {
  it("keeps the calendar day and shows the year", () => {
    expect(formatLongDate("2026-12-31")).toMatch(/31.*2026/);
  });
});

describe("formatTimeUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date(2026, 6, 24, 9, 0, 0);

  function at(offsetMs: number): string {
    return new Date(NOW.getTime() + offsetMs).toISOString();
  }

  it("returns now for past times and unparseable input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(-1))).toBe("now");
    expect(formatTimeUntil("not-a-date")).toBe("now");
  });

  it("returns < 1m under a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(30_000))).toBe("< 1m");
  });

  it("returns minutes under an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(5 * 60_000))).toBe("in 5m");
    expect(formatTimeUntil(at(59 * 60_000))).toBe("in 59m");
  });

  it("returns hours with a minute remainder under a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(90 * 60_000))).toBe("in 1h 30m");
    expect(formatTimeUntil(at(2 * 3_600_000))).toBe("in 2h");
    expect(formatTimeUntil(at(23 * 3_600_000 + 59 * 60_000))).toBe(
      "in 23h 59m"
    );
  });

  it("returns whole days from 24h up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(24 * 3_600_000))).toBe("in 1d");
    expect(formatTimeUntil(at(25 * 3_600_000))).toBe("in 1d");
    expect(formatTimeUntil(at(73 * 3_600_000))).toBe("in 3d");
  });
});

describe("formatDayTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date(2026, 6, 24, 9, 0, 0);

  function timeOf(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  it("returns an empty string for unparseable input", () => {
    expect(formatDayTime("not-a-date")).toBe("");
  });

  it("labels a same-day time as Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 24, 17, 30);
    expect(formatDayTime(target.toISOString())).toBe(
      `Today at ${timeOf(target)}`
    );
  });

  it("labels the next calendar day as Tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 25, 8, 0);
    expect(formatDayTime(target.toISOString())).toBe(
      `Tomorrow at ${timeOf(target)}`
    );
  });

  it("falls back to a weekday date for anything further out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 28, 10, 0);
    expect(formatDayTime(target.toISOString())).toBe(
      target.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    );
  });
});
