import { randomUUID } from "node:crypto";
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
  filesRoot: "/tmp/dispatch-test-files",
  dispatchBinDir: "/tmp",
  codexBin: "echo",
  claudeBin: "echo",
  opencodeBin: "echo",
  agentRuntime: "inert",
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
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM files_seen");
  await pool.query("DELETE FROM files");
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
    createdAt?: Date;
    gitContext?: object | null;
  } = {}
): Promise<void> {
  const now = opts.createdAt ?? new Date();
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id,
      created_at, updated_at, git_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
    [
      id,
      opts.name ?? id,
      opts.type ?? "claude",
      opts.status ?? "stopped",
      opts.cwd ?? "/projects/test",
      opts.persona ?? null,
      opts.parentAgentId ?? null,
      now,
      opts.gitContext ? JSON.stringify(opts.gitContext) : null,
    ]
  );
}

/** A `review` block by the reviewer, addressed to its parent; its findings are shown blocks. */
async function insertReviewBlock(
  reviewerAgentId: string,
  opts: { summary?: string; createdAt?: Date } = {}
): Promise<string> {
  const block = await pool.query<{ id: string }>(
    `INSERT INTO blocks (
       id, stream_id, author_kind, author_agent_id, to_agent_id, kind,
       data, state, delivered, created_at, updated_at
     )
     SELECT gen_random_uuid(), parent_agent_id, 'agent', id, parent_agent_id,
            'review', $2::jsonb, '{"blocks":[]}'::jsonb, true, $3, $3
     FROM agents
     WHERE id = $1
     RETURNING id`,
    [
      reviewerAgentId,
      JSON.stringify({ summary: opts.summary ?? "Needs work" }),
      opts.createdAt ?? new Date(),
    ]
  );
  return block.rows[0]!.id;
}

/**
 * A `finding` block in a review's thread, which the review shows. Statuses
 * use the summary's vocabulary: open, fixed, dismissed/ignored.
 */
async function insertFinding(
  reviewId: string,
  opts: {
    severity?: "blocker" | "major" | "minor" | "nit";
    filePath?: string | null;
    description?: string;
    status?: string;
    createdAt?: Date;
  } = {}
): Promise<void> {
  const finding = {
    severity: opts.severity ?? "minor",
    title: opts.description ?? "Test finding",
    body: opts.description ?? "Test finding",
    ...(opts.filePath ? { path: opts.filePath } : {}),
  };
  const record =
    opts.status === "fixed"
      ? { status: "resolved", resolution: "fixed" }
      : opts.status === "dismissed" || opts.status === "ignored"
        ? { status: "resolved", resolution: "dismissed" }
        : { status: "open" };
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blocks (
       id, stream_id, author_kind, author_agent_id, to_agent_id, kind,
       thread_id, reply_to, data, state, delivered, created_at, updated_at
     )
     SELECT $1, r.stream_id, r.author_kind, r.author_agent_id, r.to_agent_id,
            'finding', r.id, r.id, $3::jsonb, $4::jsonb, true, $5, $5
       FROM blocks r WHERE r.id = $2`,
    [
      id,
      reviewId,
      JSON.stringify(finding),
      JSON.stringify({
        ...record,
        by: { kind: "user" },
        at: new Date().toISOString(),
      }),
      opts.createdAt ?? new Date(),
    ]
  );
  await pool.query(
    `UPDATE blocks
        SET state = jsonb_set(state, '{blocks}', state->'blocks' || to_jsonb($2::text))
      WHERE id = $1`,
    [reviewId, id]
  );
}

/**
 * A finding on the reviewer's review, which is created on first use (one
 * review per reviewer, addressed to its parent).
 */
async function insertFeedback(
  reviewerAgentId: string,
  opts: Parameters<typeof insertFinding>[1] = {}
): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM blocks
     WHERE kind = 'review' AND author_kind = 'agent' AND author_agent_id = $1`,
    [reviewerAgentId]
  );
  const reviewId =
    existing.rows[0]?.id ??
    (await insertReviewBlock(reviewerAgentId, { createdAt: opts.createdAt }));
  await insertFinding(reviewId, opts);
}

/**
 * A reviewer's review with findings in the given states: where it stands
 * (approved, changes requested) comes from them alone.
 */
async function insertReview(
  agentId: string,
  _persona: string,
  opts: { findings?: string[]; summary?: string; createdAt?: Date } = {}
): Promise<void> {
  const reviewId = await insertReviewBlock(agentId, opts);
  for (const status of opts.findings ?? []) {
    await insertFinding(reviewId, {
      severity: "major",
      description: "Fix this",
      status,
      createdAt: opts.createdAt,
    });
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

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

    await insertFeedback("reviewer", { severity: "blocker", status: "fixed" });
    await insertFeedback("reviewer", { severity: "major", status: "open" });
    await insertFeedback("reviewer", { severity: "minor", status: "open" });
    await insertFeedback("reviewer", { severity: "nit", status: "ignored" });
    await insertFeedback("reviewer", { severity: "nit", status: "open" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "persona",
    });

    expect(result.totalFindings).toBe(5);
    expect(result.bySeverity).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 2,
      info: 0,
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

    await insertFeedback("rev", { severity: "major" });
    await insertFeedback("rev", { severity: "major" });
    await insertFeedback("rev", { severity: "nit" });

    const result = await telemetry.getFeedbackSummary(pool, {
      start: daysAgo(7),
      end: new Date(),
      groupBy: "severity",
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups.find((g) => g.key === "high")!.count).toBe(2);
    expect(result.groups.find((g) => g.key === "low")!.count).toBe(1);
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
      severity: "nit",
    });
    await insertFeedback("rev", {
      description: "Unused import",
      severity: "nit",
    });
    await insertFeedback("rev", {
      description: "Unused import",
      severity: "nit",
    });
    await insertFeedback("rev", {
      description: "Missing error handling",
      severity: "major",
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

    // No verdict is stored: a clean pass, and a review whose findings are
    // all resolved, read as approved; one with an open finding does not.
    await insertReview("r1", "sec");
    await insertReview("r2", "sec", { findings: ["open", "fixed"] });
    await insertReview("r3", "ux", { findings: ["fixed", "dismissed"] });

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
    // A review block carries its findings' date, so the old one is a
    // separate review from a second pass.
    await insertAgent("parent");
    await insertAgent("rev", { persona: "sec", parentAgentId: "parent" });
    await insertAgent("rev-old", { persona: "sec", parentAgentId: "parent" });

    await insertFeedback("rev", {
      description: "Recent",
      createdAt: hoursAgo(1),
    });
    await insertFeedback("rev-old", {
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
