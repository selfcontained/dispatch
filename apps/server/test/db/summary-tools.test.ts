import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

// Mock runCommand so AgentManager never touches tmux
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const { AgentManager } = await import("../../src/agents/manager.js");
const telemetry = await import("../../src/agents/telemetry.js");

let pool: Pool;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const testConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/tmp",
  codexBin: "echo",
  claudeBin: "echo",
  opencodeBin: "echo",
  agentRuntime: "inert",
  sessionPrefix: "dispatch",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

let manager: InstanceType<typeof AgentManager>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  manager = new AgentManager(pool, noopLogger, testConfig);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM review_thread_messages");
  await pool.query("DELETE FROM review_feedback_items");
  await pool.query("DELETE FROM reviews");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");
});

// Helpers to insert test data directly
async function insertAgent(
  id: string,
  opts: {
    name?: string;
    type?: string;
    status?: string;
    cwd?: string;
    persona?: string | null;
    parentAgentId?: string | null;
    latestEventType?: string | null;
    createdAt?: Date;
    gitContext?: object | null;
  } = {}
): Promise<void> {
  const now = opts.createdAt ?? new Date();
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id,
      latest_event_type, latest_event_message, created_at, updated_at, git_context, pins)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, '[]'::jsonb)`,
    [
      id,
      opts.name ?? id,
      opts.type ?? "claude",
      opts.status ?? "stopped",
      opts.cwd ?? "/projects/test",
      opts.persona ?? null,
      opts.parentAgentId ?? null,
      opts.latestEventType ?? "done",
      opts.latestEventType ? `Agent ${opts.latestEventType}` : null,
      now,
      opts.gitContext ? JSON.stringify(opts.gitContext) : null,
    ]
  );
}

async function insertEvent(
  agentId: string,
  eventType: string,
  createdAt: Date,
  opts: { projectDir?: string } = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_events (agent_id, event_type, message, created_at, project_dir)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      agentId,
      eventType,
      `Agent ${eventType}`,
      createdAt,
      opts.projectDir ?? "/projects/test",
    ]
  );
}

async function insertFeedback(
  reviewerAgentId: string,
  opts: {
    severity?: string;
    filePath?: string | null;
    description?: string;
    status?: string;
    createdAt?: Date;
  } = {}
): Promise<void> {
  let reviewResult = await pool.query<{ id: number }>(
    `SELECT id FROM reviews
     WHERE reviewer_type = 'agent' AND reviewer_agent_id = $1`,
    [reviewerAgentId]
  );
  if (!reviewResult.rows[0]) {
    reviewResult = await pool.query<{ id: number }>(
      `INSERT INTO reviews (
         agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id, status,
         created_at, updated_at
       )
       SELECT parent_agent_id, parent_agent_id, 'agent', id, 'open', $2, $2
       FROM agents
       WHERE id = $1
       RETURNING id`,
      [reviewerAgentId, opts.createdAt ?? new Date()]
    );
  }
  const status = opts.status ?? "open";
  const resolution =
    status === "fixed"
      ? "fixed"
      : status === "ignored" || status === "dismissed"
        ? "dismissed"
        : null;
  const itemResult = await pool.query<{ id: number }>(
    `INSERT INTO review_feedback_items (
       review_id, file_path, status, resolution, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id`,
    [
      reviewResult.rows[0]!.id,
      opts.filePath ?? null,
      resolution ? "resolved" : "open",
      resolution,
      opts.createdAt ?? new Date(),
    ]
  );
  await pool.query(
    `INSERT INTO review_thread_messages (
       feedback_item_id, author_type, author_agent_id, content, created_at
     ) VALUES ($1, 'agent', $2, $3, $4)`,
    [
      itemResult.rows[0]!.id,
      reviewerAgentId,
      JSON.stringify({ body: opts.description ?? "Test finding" }),
      opts.createdAt ?? new Date(),
    ]
  );
}

async function insertReview(
  agentId: string,
  parentAgentId: string,
  _persona: string,
  opts: {
    verdict?: string | null;
    summary?: string | null;
    status?: string;
    createdAt?: Date;
  } = {}
): Promise<void> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO reviews (
       agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id,
       status, summary, created_at, updated_at
     ) VALUES ($1, $1, 'agent', $2, $3, $4, $5, $5)
     RETURNING id`,
    [
      parentAgentId,
      agentId,
      opts.verdict === "request_changes" ? "open" : "resolved",
      opts.summary ?? "Looks good",
      opts.createdAt ?? new Date(),
    ]
  );
  if (opts.verdict === "request_changes") {
    await pool.query(
      `INSERT INTO review_feedback_items (review_id, status, created_at, updated_at)
       VALUES ($1, 'open', $2, $2)`,
      [result.rows[0]!.id, opts.createdAt ?? new Date()]
    );
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

// ── getActivitySummary ──────────────────────────────────────────────

describe("getActivitySummary", () => {
  it("returns empty results when no data exists", async () => {
    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(7),
      end: new Date(),
    });

    expect(result.projects).toHaveLength(0);
    expect(result.totals.totalWorkingMs).toBe(0);
    expect(result.totals.agentCount).toBe(0);
    expect(result.totals.sessionCount).toBe(0);
    expect(result.topAgents).toHaveLength(0);
  });

  it("computes working time from event pairs", async () => {
    await insertAgent("a1", { cwd: "/projects/test" });

    // working for 1 hour, then done
    const start = hoursAgo(3);
    const afterOneHour = new Date(start.getTime() + 3_600_000);
    await insertEvent("a1", "working", start);
    await insertEvent("a1", "done", afterOneHour);

    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(1),
      end: new Date(),
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].directory).toBe("/projects/test");
    // Working time should be ~1 hour (3600000ms)
    expect(result.projects[0].totalWorkingMs).toBeGreaterThanOrEqual(3_500_000);
    expect(result.projects[0].totalWorkingMs).toBeLessThanOrEqual(3_700_000);
    expect(result.projects[0].agentCount).toBe(1);
  });

  it("groups by project and counts sessions/outcomes", async () => {
    const gitA = { repoRoot: "/projects/alpha" };
    const gitB = { repoRoot: "/projects/beta" };

    const created = hoursAgo(2);
    await insertAgent("a1", {
      gitContext: gitA,
      latestEventType: "done",
      createdAt: created,
    });
    await insertAgent("a2", {
      gitContext: gitA,
      latestEventType: "done",
      createdAt: created,
    });
    await insertAgent("a3", {
      gitContext: gitB,
      latestEventType: "blocked",
      createdAt: created,
    });
    // error agent with no latest event — insert directly to avoid default
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, created_at, updated_at, git_context, pins)
       VALUES ('a4', 'a4', 'claude', 'error', '/projects/test', $1, $1, $2, '[]'::jsonb)`,
      [created, JSON.stringify(gitA)]
    );

    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(7),
      end: new Date(),
    });

    expect(result.projects.length).toBeGreaterThanOrEqual(2);

    const alpha = result.projects.find(
      (p) => p.directory === "/projects/alpha"
    );
    const beta = result.projects.find((p) => p.directory === "/projects/beta");

    expect(alpha).toBeDefined();
    expect(alpha!.sessionCount).toBe(3);
    expect(alpha!.outcomes.done).toBe(2);
    expect(alpha!.outcomes.error).toBe(1);

    expect(beta).toBeDefined();
    expect(beta!.sessionCount).toBe(1);
    expect(beta!.outcomes.blocked).toBe(1);
  });

  it("filters by project", async () => {
    const gitA = { repoRoot: "/projects/alpha" };
    const gitB = { repoRoot: "/projects/beta" };

    await insertAgent("a1", { gitContext: gitA, latestEventType: "done" });
    await insertAgent("a2", { gitContext: gitB, latestEventType: "done" });

    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      project: "/projects/alpha",
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].directory).toBe("/projects/alpha");
    expect(result.totals.sessionCount).toBe(1);
  });

  it("includes archived parent agents in session counts", async () => {
    await insertAgent("a1", { latestEventType: "done" });
    await insertAgent("a2", { latestEventType: "done" });
    await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = 'a2'");

    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(7),
      end: new Date(),
    });

    expect(result.totals.sessionCount).toBe(2);
  });

  it("returns top agents sorted by working time", async () => {
    await insertAgent("a1", { name: "Short worker" });
    await insertAgent("a2", { name: "Long worker" });

    // a1 works 1 hour
    await insertEvent("a1", "working", hoursAgo(5));
    await insertEvent("a1", "done", hoursAgo(4));

    // a2 works 3 hours
    await insertEvent("a2", "working", hoursAgo(6));
    await insertEvent("a2", "done", hoursAgo(3));

    const result = await telemetry.getActivitySummary(pool, {
      start: daysAgo(1),
      end: new Date(),
    });

    expect(result.topAgents.length).toBeGreaterThanOrEqual(2);
    expect(result.topAgents[0].name).toBe("Long worker");
    expect(result.topAgents[1].name).toBe("Short worker");
    expect(result.topAgents[0].totalWorkingMs).toBeGreaterThan(
      result.topAgents[1].totalWorkingMs
    );
  });

  it("handles boundary events for working time across range start", async () => {
    await insertAgent("a1");

    // Agent started working before the range, finishes inside the range
    await insertEvent("a1", "working", hoursAgo(10));
    await insertEvent("a1", "done", hoursAgo(8));

    // Query a 9-hour window — the working event is before range start
    const result = await telemetry.getActivitySummary(pool, {
      start: hoursAgo(9),
      end: new Date(),
    });

    // Should count ~1 hour of working time (from range start to done event)
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].totalWorkingMs).toBeGreaterThanOrEqual(3_400_000);
    expect(result.projects[0].totalWorkingMs).toBeLessThanOrEqual(3_700_000);
  });
});

// ── getFeedbackSummary ──────────────────────────────────────────────

describe("getFeedbackSummary", () => {
  it("returns empty results when no feedback exists", async () => {
    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(14),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(0);
    expect(result.groups).toHaveLength(0);
    expect(result.reviewVerdicts.total).toBe(0);
  });

  it("aggregates severity and status counts", async () => {
    await insertAgent("parent");
    await insertAgent("reviewer", { persona: "sec", parentAgentId: "parent" });

    await insertFeedback("reviewer", { severity: "critical", status: "fixed" });
    await insertFeedback("reviewer", { severity: "high", status: "open" });
    await insertFeedback("reviewer", { severity: "medium", status: "open" });
    await insertFeedback("reviewer", { severity: "low", status: "ignored" });
    await insertFeedback("reviewer", { severity: "info", status: "open" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(5);
    expect(result.bySeverity).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 5,
    });
    expect(result.byStatus.open).toBe(3);
    expect(result.byStatus.fixed).toBe(1);
    expect(result.byStatus.dismissed).toBe(1);
  });

  it("groups by persona", async () => {
    await insertAgent("parent");
    await insertAgent("sec-rev", {
      persona: "security-review",
      parentAgentId: "parent",
    });
    await insertAgent("ux-rev", {
      persona: "ux-review",
      parentAgentId: "parent",
    });

    await insertFeedback("sec-rev", { description: "SQL injection" });
    await insertFeedback("sec-rev", { description: "XSS risk" });
    await insertFeedback("ux-rev", { description: "Poor contrast" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.groups).toHaveLength(2);
    const secGroup = result.groups.find((g) => g.key === "security-review");
    const uxGroup = result.groups.find((g) => g.key === "ux-review");
    expect(secGroup).toBeDefined();
    expect(secGroup!.count).toBe(2);
    expect(uxGroup).toBeDefined();
    expect(uxGroup!.count).toBe(1);
  });

  it("groups by severity", async () => {
    await insertAgent("parent");
    await insertAgent("rev", { persona: "sec", parentAgentId: "parent" });

    await insertFeedback("rev", { severity: "high" });
    await insertFeedback("rev", { severity: "high" });
    await insertFeedback("rev", { severity: "low" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "severity",
    });

    expect(result.groups).toHaveLength(1);
    const infoGroup = result.groups.find((g) => g.key === "info");
    expect(infoGroup!.count).toBe(3);
  });

  it("groups by directory relative to project root", async () => {
    await insertAgent("parent", {
      cwd: "/projects/test",
      gitContext: { repoRoot: "/projects/test" },
    });
    await insertAgent("rev", {
      persona: "sec",
      parentAgentId: "parent",
      cwd: "/projects/test",
    });

    await insertFeedback("rev", {
      filePath: "/projects/test/src/auth/login.ts",
    });
    await insertFeedback("rev", {
      filePath: "/projects/test/src/auth/token.ts",
    });
    await insertFeedback("rev", { filePath: "/projects/test/src/db/query.ts" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "directory",
    });

    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    const authGroup = result.groups.find((g) => g.key === "src/auth");
    const dbGroup = result.groups.find((g) => g.key === "src/db");
    expect(authGroup).toBeDefined();
    expect(authGroup!.count).toBe(2);
    expect(dbGroup).toBeDefined();
    expect(dbGroup!.count).toBe(1);
  });

  it("deduplicates top findings by description", async () => {
    await insertAgent("parent");
    await insertAgent("rev", { persona: "sec", parentAgentId: "parent" });

    // Same description repeated 3 times
    await insertFeedback("rev", {
      description: "Unused import",
      severity: "low",
    });
    await insertFeedback("rev", {
      description: "Unused import",
      severity: "low",
    });
    await insertFeedback("rev", {
      description: "Unused import",
      severity: "low",
    });
    await insertFeedback("rev", {
      description: "Missing error handling",
      severity: "high",
    });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.topFindings).toHaveLength(2);
    expect(group.topFindings[0].description).toBe("Unused import");
    expect(group.topFindings[0].count).toBe(3);
    expect(group.topFindings[1].description).toBe("Missing error handling");
    expect(group.topFindings[1].count).toBe(1);
  });

  it("aggregates review verdicts", async () => {
    await insertAgent("p1");
    await insertAgent("p2");
    await insertAgent("r1", { persona: "sec", parentAgentId: "p1" });
    await insertAgent("r2", { persona: "sec", parentAgentId: "p2" });
    await insertAgent("r3", { persona: "ux", parentAgentId: "p1" });

    await insertReview("r1", "p1", "sec", { verdict: "approve" });
    await insertReview("r2", "p2", "sec", { verdict: "request_changes" });
    await insertReview("r3", "p1", "ux", { verdict: "approve" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.reviewVerdicts.total).toBe(3);
    expect(result.reviewVerdicts.approved).toBe(2);
    expect(result.reviewVerdicts.changesRequested).toBe(1);
  });

  it("filters by project", async () => {
    const gitA = { repoRoot: "/projects/alpha" };
    const gitB = { repoRoot: "/projects/beta" };

    await insertAgent("p1", { gitContext: gitA });
    await insertAgent("p2", { gitContext: gitB });
    await insertAgent("r1", {
      persona: "sec",
      parentAgentId: "p1",
      cwd: "/projects/alpha",
    });
    await insertAgent("r2", {
      persona: "sec",
      parentAgentId: "p2",
      cwd: "/projects/beta",
    });

    await insertFeedback("r1", { description: "Alpha finding" });
    await insertFeedback("r2", { description: "Beta finding" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      project: "/projects/alpha",
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(1);
    expect(result.groups[0].topFindings[0].description).toBe("Alpha finding");
  });

  it("respects date range boundaries", async () => {
    await insertAgent("parent");
    await insertAgent("rev", { persona: "sec", parentAgentId: "parent" });

    await insertFeedback("rev", {
      description: "Recent",
      createdAt: hoursAgo(1),
    });
    await insertFeedback("rev", {
      description: "Old",
      createdAt: daysAgo(30),
    });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(1);
    expect(result.groups[0].topFindings[0].description).toBe("Recent");
  });

  it("includes feedback and review verdicts for archived parent agents", async () => {
    await insertAgent("parent");
    await insertAgent("reviewer", { persona: "sec", parentAgentId: "parent" });
    await insertFeedback("reviewer", {
      description: "Archived parent finding",
    });
    await pool.query(
      "UPDATE agents SET deleted_at = NOW() WHERE id = 'parent'"
    );

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].topFindings[0].description).toBe(
      "Archived parent finding"
    );
    expect(result.reviewVerdicts.total).toBe(1);
    expect(result.reviewVerdicts.approved).toBe(0);
    expect(result.reviewVerdicts.changesRequested).toBe(1);
  });
});
