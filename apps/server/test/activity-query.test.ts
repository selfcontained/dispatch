import { describe, expect, it } from "vitest";

import {
  parseActivityQuery,
  timeRangeClause,
  dateTruncTz,
  escapeLike,
} from "../src/server/activity-query.js";

describe("parseActivityQuery", () => {
  it("returns defaults for empty input", () => {
    const result = parseActivityQuery({});
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    expect(result.granularity).toBe("day");
    expect(result.tz).toBeTruthy();
  });

  it("parses valid start and end dates", () => {
    const result = parseActivityQuery({
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-31T23:59:59Z",
    });
    expect(result.start).toBeInstanceOf(Date);
    expect(result.end).toBeInstanceOf(Date);
    expect(result.start!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result.end!.toISOString()).toBe("2026-01-31T23:59:59.000Z");
  });

  it("returns null for invalid date strings", () => {
    const result = parseActivityQuery({
      start: "not-a-date",
      end: "also-not-a-date",
    });
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
  });

  it("accepts all valid granularities", () => {
    for (const granularity of ["hour", "day", "week", "month"]) {
      const result = parseActivityQuery({ granularity });
      expect(result.granularity).toBe(granularity);
    }
  });

  it("defaults invalid granularity to day", () => {
    const result = parseActivityQuery({ granularity: "year" });
    expect(result.granularity).toBe("day");
  });

  it("accepts a valid timezone", () => {
    const result = parseActivityQuery({ tz: "America/New_York" });
    expect(result.tz).toBe("America/New_York");
  });

  it("falls back to system timezone for invalid tz", () => {
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = parseActivityQuery({ tz: "Invalid/Timezone" });
    expect(result.tz).toBe(fallback);
  });

  it("falls back to system timezone for empty tz", () => {
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = parseActivityQuery({ tz: "" });
    expect(result.tz).toBe(fallback);
  });

  it("ignores non-string query values", () => {
    const result = parseActivityQuery({
      start: 12345,
      end: null,
      tz: 42,
      granularity: true,
    });
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    expect(result.granularity).toBe("day");
  });
});

describe("timeRangeClause", () => {
  it("returns empty clause when no start or end", () => {
    const aq = parseActivityQuery({});
    const { clause, params } = timeRangeClause(aq, "created_at");
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("returns start-only clause", () => {
    const aq = parseActivityQuery({ start: "2026-01-01T00:00:00Z" });
    const { clause, params } = timeRangeClause(aq, "created_at");
    expect(clause).toBe("WHERE created_at >= $1");
    expect(params).toHaveLength(1);
  });

  it("returns end-only clause", () => {
    const aq = parseActivityQuery({ end: "2026-01-31T23:59:59Z" });
    const { clause, params } = timeRangeClause(aq, "created_at");
    expect(clause).toBe("WHERE created_at <= $1");
    expect(params).toHaveLength(1);
  });

  it("returns both start and end clause", () => {
    const aq = parseActivityQuery({
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-31T23:59:59Z",
    });
    const { clause, params } = timeRangeClause(aq, "created_at");
    expect(clause).toBe("WHERE created_at >= $1 AND created_at <= $2");
    expect(params).toHaveLength(2);
  });

  it("applies paramOffset correctly", () => {
    const aq = parseActivityQuery({
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-31T23:59:59Z",
    });
    const { clause } = timeRangeClause(aq, "ts", 3);
    expect(clause).toBe("WHERE ts >= $4 AND ts <= $5");
  });
});

describe("dateTruncTz", () => {
  it("produces hour format with to_char for hourly granularity", () => {
    const sql = dateTruncTz("hour", "created_at", "America/New_York");
    expect(sql).toContain("to_char");
    expect(sql).toContain("HH24:00");
    expect(sql).toContain("America/New_York");
  });

  it("produces date::text for non-hour granularity", () => {
    const sql = dateTruncTz("day", "created_at", "UTC");
    expect(sql).toContain("::date::text");
    expect(sql).not.toContain("to_char");
  });

  it("escapes single quotes in timezone", () => {
    const sql = dateTruncTz("day", "created_at", "O'Clock/Zone");
    expect(sql).toContain("O''Clock/Zone");
  });

  it("includes date_trunc with the given granularity", () => {
    for (const g of ["day", "week", "month"] as const) {
      const sql = dateTruncTz(g, "created_at", "UTC");
      expect(sql).toContain(`date_trunc('${g}'`);
    }
  });
});

describe("escapeLike", () => {
  it("returns unmodified string with no special characters", () => {
    expect(escapeLike("hello world")).toBe("hello world");
  });

  it("escapes percent sign", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapes underscore", () => {
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  it("escapes backslash", () => {
    expect(escapeLike("path\\file")).toBe("path\\\\file");
  });

  it("escapes all special characters in combination", () => {
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  it("handles empty string", () => {
    expect(escapeLike("")).toBe("");
  });
});
