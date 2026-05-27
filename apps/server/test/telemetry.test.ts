import { describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import {
  getActivitySummary,
  getAgentHistory,
  getFeedbackSummary,
  listMedia,
} from "../src/agents/telemetry.js";

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

describe("getActivitySummary", () => {
  it("returns empty result when no data exists", async () => {
    const pool = mockPool(
      { rows: [] }, // working time
      { rows: [] }, // sessions
      { rows: [] } // agent meta
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.period.start).toBe(rangeStart.toISOString());
    expect(result.period.end).toBe(rangeEnd.toISOString());
    expect(result.projects).toEqual([]);
    expect(result.totals).toEqual({
      totalWorkingMs: 0,
      agentCount: 0,
      sessionCount: 0,
    });
    expect(result.topAgents).toEqual([]);
  });

  it("aggregates working time per project from multiple agents", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_001", projectDir: "/proj/a", totalWorkingMs: "5000" },
          { agentId: "agt_002", projectDir: "/proj/a", totalWorkingMs: "3000" },
          { agentId: "agt_003", projectDir: "/proj/b", totalWorkingMs: "7000" },
        ],
      },
      {
        rows: [
          {
            projectDir: "/proj/a",
            sessionCount: "2",
            doneCount: "1",
            idleCount: "0",
            blockedCount: "1",
            errorCount: "0",
          },
          {
            projectDir: "/proj/b",
            sessionCount: "1",
            doneCount: "1",
            idleCount: "0",
            blockedCount: "0",
            errorCount: "0",
          },
        ],
      },
      {
        rows: [
          {
            id: "agt_001",
            name: "agent-1",
            projectDir: "/proj/a",
            latestEventType: "done",
            latestEventMessage: "Finished",
          },
          {
            id: "agt_002",
            name: "agent-2",
            projectDir: "/proj/a",
            latestEventType: "blocked",
            latestEventMessage: "Stuck",
          },
          {
            id: "agt_003",
            name: "agent-3",
            projectDir: "/proj/b",
            latestEventType: "done",
            latestEventMessage: "All done",
          },
        ],
      }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.projects).toHaveLength(2);
    // Sorted by totalWorkingMs descending
    expect(result.projects[0].directory).toBe("/proj/a");
    expect(result.projects[0].totalWorkingMs).toBe(8000);
    expect(result.projects[0].agentCount).toBe(2);
    expect(result.projects[0].sessionCount).toBe(2);
    expect(result.projects[0].outcomes.done).toBe(1);
    expect(result.projects[0].outcomes.blocked).toBe(1);

    expect(result.projects[1].directory).toBe("/proj/b");
    expect(result.projects[1].totalWorkingMs).toBe(7000);
    expect(result.projects[1].agentCount).toBe(1);
  });

  it("computes totals across all projects", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_001", projectDir: "/proj/a", totalWorkingMs: "4000" },
          { agentId: "agt_002", projectDir: "/proj/b", totalWorkingMs: "6000" },
        ],
      },
      {
        rows: [
          {
            projectDir: "/proj/a",
            sessionCount: "3",
            doneCount: "2",
            idleCount: "1",
            blockedCount: "0",
            errorCount: "0",
          },
          {
            projectDir: "/proj/b",
            sessionCount: "2",
            doneCount: "2",
            idleCount: "0",
            blockedCount: "0",
            errorCount: "0",
          },
        ],
      },
      {
        rows: [
          {
            id: "agt_001",
            name: "a1",
            projectDir: "/proj/a",
            latestEventType: "done",
            latestEventMessage: "",
          },
          {
            id: "agt_002",
            name: "a2",
            projectDir: "/proj/b",
            latestEventType: "done",
            latestEventMessage: "",
          },
        ],
      }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.totals.totalWorkingMs).toBe(10000);
    expect(result.totals.agentCount).toBe(2);
    expect(result.totals.sessionCount).toBe(5);
  });

  it("builds top agents sorted by working time descending", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_low", projectDir: "/proj", totalWorkingMs: "1000" },
          { agentId: "agt_high", projectDir: "/proj", totalWorkingMs: "9000" },
          { agentId: "agt_mid", projectDir: "/proj", totalWorkingMs: "5000" },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            id: "agt_low",
            name: "low",
            projectDir: "/proj",
            latestEventType: "idle",
            latestEventMessage: "idle",
          },
          {
            id: "agt_high",
            name: "high",
            projectDir: "/proj",
            latestEventType: "done",
            latestEventMessage: "done",
          },
          {
            id: "agt_mid",
            name: "mid",
            projectDir: "/proj",
            latestEventType: "done",
            latestEventMessage: "done",
          },
        ],
      }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.topAgents).toHaveLength(3);
    expect(result.topAgents[0].id).toBe("agt_high");
    expect(result.topAgents[0].totalWorkingMs).toBe(9000);
    expect(result.topAgents[1].id).toBe("agt_mid");
    expect(result.topAgents[2].id).toBe("agt_low");
  });

  it("caps top agents at 10 entries", async () => {
    const workingRows = Array.from({ length: 15 }, (_, i) => ({
      agentId: `agt_${String(i).padStart(3, "0")}`,
      projectDir: "/proj",
      totalWorkingMs: String((15 - i) * 1000),
    }));
    const metaRows = workingRows.map((r) => ({
      id: r.agentId,
      name: r.agentId,
      projectDir: "/proj",
      latestEventType: "done",
      latestEventMessage: "done",
    }));

    const pool = mockPool(
      { rows: workingRows },
      { rows: [] },
      { rows: metaRows }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.topAgents).toHaveLength(10);
    expect(result.topAgents[0].id).toBe("agt_000");
    expect(result.topAgents[9].id).toBe("agt_009");
  });

  it("handles agents with working time but no session rows", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_001", projectDir: "/proj/x", totalWorkingMs: "2000" },
        ],
      },
      { rows: [] }, // no sessions
      {
        rows: [
          {
            id: "agt_001",
            name: "lonely",
            projectDir: "/proj/x",
            latestEventType: "done",
            latestEventMessage: "done",
          },
        ],
      }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].totalWorkingMs).toBe(2000);
    expect(result.projects[0].sessionCount).toBe(0);
    expect(result.projects[0].outcomes.done).toBe(0);
  });

  it("handles sessions with no working time rows", async () => {
    const pool = mockPool(
      { rows: [] }, // no working time
      {
        rows: [
          {
            projectDir: "/proj/y",
            sessionCount: "5",
            doneCount: "3",
            idleCount: "2",
            blockedCount: "0",
            errorCount: "0",
          },
        ],
      },
      { rows: [] }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].totalWorkingMs).toBe(0);
    expect(result.projects[0].sessionCount).toBe(5);
    expect(result.projects[0].agentCount).toBe(0);
  });

  it("passes project filter to all queries", async () => {
    const pool = mockPool({ rows: [] }, { rows: [] }, { rows: [] });

    await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
      project: "/my/project",
    });

    const query = pool.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(3);
    // Working time query should have 3 params (start, end, project)
    expect(query.mock.calls[0][1]).toHaveLength(3);
    expect(query.mock.calls[0][1][2]).toBe("/my/project");
  });

  it("uses fallback name when agent meta is missing", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_ghost", projectDir: "/proj", totalWorkingMs: "1000" },
        ],
      },
      { rows: [] },
      { rows: [] } // no meta for agt_ghost
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.topAgents[0].name).toBe("agt_ghost");
    expect(result.topAgents[0].latestEventMessage).toBe("");
    expect(result.topAgents[0].latestEventType).toBe("");
  });

  it("sums working time across multiple rows for the same agent", async () => {
    const pool = mockPool(
      {
        rows: [
          { agentId: "agt_001", projectDir: "/proj/a", totalWorkingMs: "2000" },
          { agentId: "agt_001", projectDir: "/proj/b", totalWorkingMs: "3000" },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            id: "agt_001",
            name: "multi",
            projectDir: "/proj/a",
            latestEventType: "done",
            latestEventMessage: "done",
          },
        ],
      }
    );

    const result = await getActivitySummary(pool, {
      start: rangeStart,
      end: rangeEnd,
    });

    expect(result.topAgents[0].totalWorkingMs).toBe(5000);
    // The agent's project should be the first one seen
    expect(result.topAgents[0].project).toBe("/proj/a");
  });
});

describe("getAgentHistory", () => {
  const baseParams = {
    start: rangeStart,
    end: rangeEnd,
    limit: 50,
    offset: 0,
    includeEvents: false,
    includeFeedback: false,
    includeReviews: false,
    includeChildren: false,
  };

  it("returns empty result when no agents exist", async () => {
    const pool = mockPool(
      { rows: [{ count: "0" }] }, // count
      { rows: [] }, // list
      { rows: [] }, // events
      { rows: [] }, // feedback
      { rows: [] } // reviews
    );

    const result = await getAgentHistory(pool, baseParams);

    expect(result.agents).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("maps agent rows to history entries", async () => {
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_test01",
            name: "test-agent",
            type: "claude",
            status: "stopped",
            projectDir: "/project",
            createdAt: "2026-01-15T10:00:00Z",
            latestEventType: "done",
            latestEventMessage: "Finished",
            pins: [{ label: "PR", value: "#42", type: "pr" }],
            gitContext: { branch: "main", repoRoot: "/project" },
            worktreeBranch: "feature-x",
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, baseParams);

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0];
    expect(agent.id).toBe("agt_test01");
    expect(agent.name).toBe("test-agent");
    expect(agent.type).toBe("claude");
    expect(agent.project).toBe("/project");
    expect(agent.pins).toEqual([{ label: "PR", value: "#42", type: "pr" }]);
    expect(agent.git).toEqual({ branch: "main", worktreeBranch: "feature-x" });
  });

  it("sets git to null when gitContext is null", async () => {
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_nogit",
            name: "no-git",
            type: "claude",
            status: "stopped",
            projectDir: "/tmp",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: null,
            latestEventMessage: null,
            pins: [],
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, baseParams);
    expect(result.agents[0].git).toBeNull();
  });

  it("attaches events when includeEvents is true", async () => {
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_ev",
            name: "evented",
            type: "claude",
            status: "stopped",
            projectDir: "/proj",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: "done",
            latestEventMessage: "done",
            pins: [],
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      {
        rows: [
          {
            agentId: "agt_ev",
            type: "working",
            message: "Reading files",
            createdAt: "2026-01-01T00:01:00Z",
          },
          {
            agentId: "agt_ev",
            type: "done",
            message: "Finished",
            createdAt: "2026-01-01T00:05:00Z",
          },
        ],
      },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      includeEvents: true,
    });

    expect(result.agents[0].events).toHaveLength(2);
    expect(result.agents[0].events![0].type).toBe("working");
    expect(result.agents[0].events![1].type).toBe("done");
  });

  it("does not include events key when includeEvents is false", async () => {
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_noev",
            name: "no-events",
            type: "claude",
            status: "stopped",
            projectDir: "/proj",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: null,
            latestEventMessage: null,
            pins: [],
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      includeEvents: false,
    });

    expect(result.agents[0]).not.toHaveProperty("events");
  });

  it("attaches feedback grouped by parent agent", async () => {
    // Query order: count, list, then Promise.all([events, feedback, reviews]).
    // includeEvents=false skips that query, so feedback is call index 2.
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_parent",
            name: "parent",
            type: "claude",
            status: "stopped",
            projectDir: "/proj",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: "done",
            latestEventMessage: "done",
            pins: [],
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      {
        rows: [
          {
            parentAgentId: "agt_parent",
            id: 1,
            persona: "security",
            severity: "high",
            description: "SQL injection risk",
            filePath: "/src/api.ts",
            suggestion: "Use parameterized queries",
            status: "open",
          },
          {
            parentAgentId: "agt_parent",
            id: 2,
            persona: "security",
            severity: "low",
            description: "Missing CSRF token",
            filePath: null,
            suggestion: null,
            status: "fixed",
          },
        ],
      }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      includeFeedback: true,
    });

    expect(result.agents[0].feedback).toHaveLength(2);
    expect(result.agents[0].feedback![0].severity).toBe("high");
    expect(result.agents[0].feedback![1].status).toBe("fixed");
  });

  it("attaches reviews grouped by parent agent", async () => {
    // includeEvents=false and includeFeedback=false skip their queries,
    // so reviews is call index 2.
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_reviewed",
            name: "reviewed",
            type: "claude",
            status: "stopped",
            projectDir: "/proj",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: "done",
            latestEventMessage: "done",
            pins: [],
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      {
        rows: [
          {
            parentAgentId: "agt_reviewed",
            persona: "code-review",
            status: "completed",
            verdict: "approve",
            summary: "Looks good",
            filesReviewed: ["src/api.ts"],
          },
        ],
      }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      includeReviews: true,
    });

    expect(result.agents[0].reviews).toHaveLength(1);
    expect(result.agents[0].reviews![0].verdict).toBe("approve");
    expect(result.agents[0].reviews![0].filesReviewed).toEqual(["src/api.ts"]);
  });

  it("computes hasMore correctly with pagination", async () => {
    const pool = mockPool(
      { rows: [{ count: "100" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(100);
    expect(result.hasMore).toBe(true);
  });

  it("hasMore is false when offset + limit >= total", async () => {
    const pool = mockPool(
      { rows: [{ count: "5" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, {
      ...baseParams,
      limit: 10,
      offset: 0,
    });

    expect(result.hasMore).toBe(false);
  });

  it("handles null pins gracefully", async () => {
    const pool = mockPool(
      { rows: [{ count: "1" }] },
      {
        rows: [
          {
            id: "agt_np",
            name: "no-pins",
            type: "claude",
            status: "stopped",
            projectDir: "/proj",
            createdAt: "2026-01-01T00:00:00Z",
            latestEventType: null,
            latestEventMessage: null,
            pins: null,
            gitContext: null,
            worktreeBranch: null,
            persona: null,
            parentAgentId: null,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const result = await getAgentHistory(pool, baseParams);
    expect(result.agents[0].pins).toEqual([]);
  });
});

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

describe("listMedia", () => {
  it("returns formatted media entries with file paths", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "screenshot.png",
          description: "Home page",
          source: "playwright",
          sizeBytes: 1024,
          createdAt: new Date("2026-01-15T10:00:00Z"),
          mediaDir: "/media/agt_001",
        },
      ],
    });

    const result = await listMedia(pool, "agt_001", (id) => `/fallback/${id}`);

    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("screenshot.png");
    expect(result[0].filePath).toBe("/media/agt_001/screenshot.png");
    expect(result[0].description).toBe("Home page");
    expect(result[0].source).toBe("playwright");
    expect(result[0].sizeBytes).toBe(1024);
    expect(result[0].createdAt).toBe("2026-01-15T10:00:00.000Z");
  });

  it("uses fallback media dir when mediaDir is null", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "photo.jpg",
          description: null,
          source: "upload",
          sizeBytes: 2048,
          createdAt: new Date("2026-01-20T12:00:00Z"),
          mediaDir: null,
        },
      ],
    });

    const result = await listMedia(pool, "agt_002", (id) => `/fallback/${id}`);

    expect(result[0].filePath).toBe("/fallback/agt_002/photo.jpg");
  });

  it("returns empty array when no media exists", async () => {
    const pool = mockPool({ rows: [] });

    const result = await listMedia(pool, "agt_none", (id) => `/fallback/${id}`);

    expect(result).toEqual([]);
  });

  it("handles multiple media entries preserving order", async () => {
    const pool = mockPool({
      rows: [
        {
          fileName: "first.png",
          description: null,
          source: "agent",
          sizeBytes: 100,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          mediaDir: "/m",
        },
        {
          fileName: "second.png",
          description: "desc",
          source: "agent",
          sizeBytes: 200,
          createdAt: new Date("2026-01-02T00:00:00Z"),
          mediaDir: "/m",
        },
      ],
    });

    const result = await listMedia(pool, "agt_multi", () => "/fb");

    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe("first.png");
    expect(result[1].fileName).toBe("second.png");
  });
});
