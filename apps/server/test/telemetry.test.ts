import { describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { getFeedbackSummary, listFiles } from "../src/agents/telemetry.js";

function mockPool(...results: Array<Partial<QueryResult>>): Pool {
  let callIndex = 0;
  return {
    query: vi.fn(async () => {
      const r = results[callIndex] ?? { rows: [], rowCount: 0 };
      callIndex++;
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
    }),
  } as unknown as Pool;
}

const rangeStart = new Date("2026-01-01T00:00:00Z");
const rangeEnd = new Date("2026-01-31T23:59:59Z");

describe("getFeedbackSummary", () => {
  const baseParams = {
    start: rangeStart,
    end: rangeEnd,
    groupBy: "persona" as const,
  };

  it("returns empty result when no feedback exists", async () => {
    const pool = mockPool(
      { rows: [] }, // feedback
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] } // verdicts
    );

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.totalFindings).toBe(0);
    expect(result.bySeverity).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
    expect(result.byStatus).toEqual({
      open: 0,
      fixed: 0,
      ignored: 0,
      dismissed: 0,
    });
    expect(result.groups).toEqual([]);
  });

  it("aggregates severity and status counts", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "security",
            severity: "high",
            description: "XSS",
            filePath: "/src/a.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "security",
            severity: "critical",
            description: "SQL injection",
            filePath: "/src/b.ts",
            status: "fixed",
            projectRoot: "/proj",
          },
          {
            persona: "style",
            severity: "low",
            description: "Missing semicolon",
            filePath: "/src/c.ts",
            status: "dismissed",
            projectRoot: "/proj",
          },
          {
            persona: "style",
            severity: "info",
            description: "Consider renaming",
            filePath: null,
            status: "ignored",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.totalFindings).toBe(4);
    expect(result.bySeverity.critical).toBe(1);
    expect(result.bySeverity.high).toBe(1);
    expect(result.bySeverity.low).toBe(1);
    expect(result.bySeverity.info).toBe(1);
    expect(result.byStatus.open).toBe(1);
    expect(result.byStatus.fixed).toBe(1);
    expect(result.byStatus.dismissed).toBe(1);
    expect(result.byStatus.ignored).toBe(1);
  });

  it("groups by persona with count-descending sort", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "security",
            severity: "high",
            description: "Issue A",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "style",
            severity: "low",
            description: "Issue B",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "style",
            severity: "low",
            description: "Issue C",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "style",
            severity: "medium",
            description: "Issue D",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, {
      ...baseParams,
      groupBy: "persona",
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].key).toBe("style");
    expect(result.groups[0].count).toBe(3);
    expect(result.groups[0].bySeverity.low).toBe(2);
    expect(result.groups[0].bySeverity.medium).toBe(1);
    expect(result.groups[1].key).toBe("security");
    expect(result.groups[1].count).toBe(1);
  });

  it("groups by severity", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "sec",
            severity: "high",
            description: "A",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "high",
            description: "B",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "low",
            description: "C",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, {
      ...baseParams,
      groupBy: "severity",
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].key).toBe("high");
    expect(result.groups[0].count).toBe(2);
    expect(result.groups[1].key).toBe("low");
    expect(result.groups[1].count).toBe(1);
  });

  it("groups by directory, extracting relative paths", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "sec",
            severity: "high",
            description: "A",
            filePath: "/proj/src/routes/api.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "high",
            description: "B",
            filePath: "/proj/src/routes/auth.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "low",
            description: "C",
            filePath: "/proj/lib/util.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "info",
            description: "D",
            filePath: null,
            status: "open",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, {
      ...baseParams,
      groupBy: "directory",
    });

    expect(result.groups).toHaveLength(3);
    const keys = result.groups.map((g) => g.key);
    expect(keys).toContain("src/routes");
    expect(keys).toContain("lib");
    expect(keys).toContain("(no file)");
  });

  it("uses '.' for files with no directory component", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "sec",
            severity: "low",
            description: "Root file",
            filePath: "/proj/README.md",
            status: "open",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, {
      ...baseParams,
      groupBy: "directory",
    });

    expect(result.groups[0].key).toBe(".");
  });

  it("deduplicates top findings by description", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "sec",
            severity: "high",
            description: "Missing auth check",
            filePath: "/proj/src/a.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "high",
            description: "Missing auth check",
            filePath: "/proj/src/b.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "high",
            description: "Missing auth check",
            filePath: "/proj/src/c.ts",
            status: "open",
            projectRoot: "/proj",
          },
          {
            persona: "sec",
            severity: "medium",
            description: "Unique issue",
            filePath: "/proj/src/d.ts",
            status: "open",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, baseParams);

    const topFindings = result.groups[0].topFindings;
    expect(topFindings).toHaveLength(2);
    expect(topFindings[0].description).toBe("Missing auth check");
    expect(topFindings[0].count).toBe(3);
    expect(topFindings[1].description).toBe("Unique issue");
    expect(topFindings[1].count).toBe(1);
  });

  it("caps top findings at 5 entries", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      persona: "sec",
      severity: "medium",
      description: `Finding ${i}`,
      filePath: null,
      status: "open",
      projectRoot: "/proj",
    }));

    const pool = mockPool(
      { rows },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.groups[0].topFindings.length).toBeLessThanOrEqual(5);
  });

  it("includes review verdict aggregates", async () => {
    const pool = mockPool(
      { rows: [] },
      { rows: [{ total: "10", approved: "7", changesRequested: "3" }] }
    );

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.reviewVerdicts.total).toBe(10);
    expect(result.reviewVerdicts.approved).toBe(7);
    expect(result.reviewVerdicts.changesRequested).toBe(3);
  });

  it("handles missing verdict row gracefully", async () => {
    const pool = mockPool({ rows: [] }, { rows: [] });

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.reviewVerdicts).toEqual({
      total: 0,
      approved: 0,
      changesRequested: 0,
    });
  });

  it("ignores unknown severity and status values", async () => {
    const pool = mockPool(
      {
        rows: [
          {
            persona: "sec",
            severity: "ultra-critical",
            description: "Unknown sev",
            filePath: null,
            status: "quarantined",
            projectRoot: "/proj",
          },
        ],
      },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    const result = await getFeedbackSummary(pool, baseParams);

    expect(result.totalFindings).toBe(1);
    expect(result.bySeverity).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
    expect(result.byStatus).toEqual({
      open: 0,
      fixed: 0,
      ignored: 0,
      dismissed: 0,
    });
  });

  it("passes project filter to queries", async () => {
    const pool = mockPool(
      { rows: [] },
      { rows: [{ total: "0", approved: "0", changesRequested: "0" }] }
    );

    await getFeedbackSummary(pool, { ...baseParams, project: "/my/proj" });

    const query = pool.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);
    // Both queries should have 3 params when project filter is set
    expect(query.mock.calls[0][1]).toHaveLength(3);
    expect(query.mock.calls[0][1][2]).toBe("/my/proj");
    expect(query.mock.calls[1][1]).toHaveLength(3);
    expect(query.mock.calls[1][1][2]).toBe("/my/proj");
  });
});

describe("listFiles", () => {
  it("returns formatted file entries with file paths", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "screenshot.png",
          description: "Home page",
          source: "playwright",
          sizeBytes: 1024,
          createdAt: new Date("2026-01-15T10:00:00Z"),
          filesDir: "/files/agt_001",
        },
      ],
    });

    const result = await listFiles(pool, "agt_001", (id) => `/fallback/${id}`);

    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("screenshot.png");
    expect(result[0].filePath).toBe("/files/agt_001/screenshot.png");
    expect(result[0].description).toBe("Home page");
    expect(result[0].source).toBe("playwright");
    expect(result[0].sizeBytes).toBe(1024);
    expect(result[0].createdAt).toBe("2026-01-15T10:00:00.000Z");
  });

  it("uses fallback files dir when filesDir is null", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "photo.jpg",
          description: null,
          source: "upload",
          sizeBytes: 2048,
          createdAt: new Date("2026-01-20T12:00:00Z"),
          filesDir: null,
        },
      ],
    });

    const result = await listFiles(pool, "agt_002", (id) => `/fallback/${id}`);

    expect(result[0].filePath).toBe("/fallback/agt_002/photo.jpg");
  });

  it("returns empty array when no files exist", async () => {
    const pool = mockPool({ rows: [] });

    const result = await listFiles(pool, "agt_none", (id) => `/fallback/${id}`);

    expect(result).toEqual([]);
  });

  it("handles multiple file entries preserving order", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "first.png",
          description: null,
          source: "agent",
          sizeBytes: 100,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          filesDir: "/m",
        },
        {
          fileName: "second.png",
          description: "desc",
          source: "agent",
          sizeBytes: 200,
          createdAt: new Date("2026-01-02T00:00:00Z"),
          filesDir: "/m",
        },
      ],
    });

    const result = await listFiles(pool, "agt_multi", () => "/fb");

    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe("first.png");
    expect(result[1].fileName).toBe("second.png");
  });
});
