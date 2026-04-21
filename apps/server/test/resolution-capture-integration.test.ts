/**
 * HTTP integration tests for CRU-128 resolution capture (CRU-130).
 *
 * Exercises the real Fastify routes that back the new MCP tools so we catch
 * endpoint-level validation drift (status codes, body shapes, auth) in addition
 * to the AgentManager unit tests.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  setupTestDb,
  teardownTestDb,
  runTestMigrations,
  getTestDatabaseUrl,
} from "./db/setup.js";

// Hoisted mock state — readable by any runCommand caller (resolveHeadSha, etc.)
const mockState = vi.hoisted(() => ({
  headSha: "cafef00dcafef00dcafef00dcafef00dcafef00d",
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async (_cmd: string, args: string[]) => {
    if (
      args?.[0] === "-C" &&
      args?.[2] === "rev-parse" &&
      args?.[3] === "HEAD"
    ) {
      return { exitCode: 0, stdout: mockState.headSha, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
}));

let pool: Pool;
let app: FastifyInstance;
let createSession: typeof import("../src/auth.js").createSession;
let sessionCookie: string;

// See mcp-auth-integration.test.ts — the MCP SDK's StreamableHTTP transport
// schedules a 500 ms drain that fires a destroySoon that Fastify inject()
// sockets don't implement. Swallow only that specific teardown error.
const uncaughtExceptionFilter = (err: Error): void => {
  if (
    err instanceof TypeError &&
    err.message.includes("destroySoon is not a function")
  ) {
    return;
  }
  throw err;
};

beforeAll(async () => {
  process.prependListener("uncaughtException", uncaughtExceptionFilter);

  pool = await setupTestDb();
  await runTestMigrations();

  process.env.DATABASE_URL = getTestDatabaseUrl();
  process.env.DISPATCH_AGENT_RUNTIME = "inert";
  process.env.DISPATCH_PORT = "6769";
  process.env.DISPATCH_HOST = "127.0.0.1";

  const auth = await import("../src/auth.js");
  ({ createSession } = auth);

  const serverModule = await import("../src/server.js");
  app = await serverModule.initializeApp({
    runMigrations: false,
    reconcileState: false,
  });

  const setupResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password: "hunter2hunter2" },
  });
  expect(setupResponse.statusCode).toBe(200);
});

afterAll(async () => {
  const serverModule = await import("../src/server.js");
  await serverModule.closeApp();
  delete process.env.DISPATCH_AGENT_RUNTIME;
  delete process.env.DATABASE_URL;
  delete process.env.DISPATCH_PORT;
  delete process.env.DISPATCH_HOST;
  await teardownTestDb();
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.off("uncaughtException", uncaughtExceptionFilter);
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_feedback");
  // persona_review_resolutions cascades from persona_reviews, which cascades
  // from agents, but delete explicitly for clarity/order-independence.
  await pool.query("DELETE FROM persona_review_resolutions");
  await pool.query("DELETE FROM persona_reviews");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM sessions");
  const session = await createSession(pool);
  const signed = (
    app as FastifyInstance & { signCookie: (value: string) => string }
  ).signCookie(session);
  sessionCookie = `dispatch_session=${signed}`;
  mockState.headSha = "cafef00dcafef00dcafef00dcafef00dcafef00d";
});

let agentCounter = 0;
function nextAgentId(): string {
  agentCounter += 1;
  // agt_ + 12 hex chars — matches production format the MCP auth checks expect
  return `agt_${agentCounter.toString(16).padStart(12, "0")}`;
}

async function insertAgent(
  overrides: {
    parentAgentId?: string;
    persona?: string;
  } = {}
): Promise<string> {
  const id = nextAgentId();
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, parent_agent_id, persona)
     VALUES ($1, $2, 'codex', 'running', '/tmp', $3, $4)`,
    [
      id,
      `agent-${id.slice(-6)}`,
      overrides.parentAgentId ?? null,
      overrides.persona ?? null,
    ]
  );
  return id;
}

async function insertFeedback(
  childId: string,
  description = "finding"
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO agent_feedback (agent_id, severity, description)
     VALUES ($1, 'info', $2)
     RETURNING id`,
    [childId, description]
  );
  return result.rows[0]!.id;
}

async function insertPersonaReview(
  childId: string,
  parentId: string,
  status: "reviewing" | "complete" = "complete"
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO persona_reviews (agent_id, parent_agent_id, persona, status, verdict, summary)
     VALUES ($1, $2, 'security-review', $3,
             CASE WHEN $3 = 'complete' THEN 'approve' ELSE NULL END,
             CASE WHEN $3 = 'complete' THEN 'done' ELSE NULL END)
     RETURNING id`,
    [childId, parentId, status]
  );
  return result.rows[0]!.id;
}

describe("PATCH /api/v1/agents/:id/feedback/:feedbackId — resolution capture", () => {
  it("rejects non-string reason", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "fixed", reason: 123 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/reason must be a string/);
  });

  it("rejects a reason that exceeds the 10,000 character limit", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "ignored", reason: "x".repeat(10_001) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/10,000 character/);
  });

  it("rejects ignored without a reason (400)", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "ignored" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/reason is required/i);
  });

  it("accepts ignored with a reason and records reason + commit + resolved_at", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "ignored", reason: "Out of scope for this release." },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().feedback;
    expect(body.status).toBe("ignored");
    expect(body.resolutionReason).toBe("Out of scope for this release.");
    expect(body.resolutionCommit).toBe(mockState.headSha);
    expect(body.resolvedAt).toBeTruthy();
  });

  it("accepts fixed without a reason and still records the resolution commit", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "fixed" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().feedback;
    expect(body.status).toBe("fixed");
    expect(body.resolutionReason).toBeNull();
    expect(body.resolutionCommit).toBe(mockState.headSha);
  });

  it("does not compute a resolution commit when reverting to 'open'", async () => {
    const childId = await insertAgent();
    const feedbackId = await insertFeedback(childId);
    // Pre-resolve so there's state to revert.
    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "fixed" },
    });
    expect(first.statusCode).toBe(200);

    // Change the mock SHA — if the server wrongly computed HEAD on a revert,
    // the new SHA would leak through.
    mockState.headSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const reopen = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${childId}/feedback/${feedbackId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "open" },
    });

    expect(reopen.statusCode).toBe(200);
    const body = reopen.json().feedback;
    expect(body.status).toBe("open");
    expect(body.resolvedAt).toBeNull();
    // First-resolve commit preserved because the endpoint only touches
    // resolution metadata on transitions into fixed/ignored.
    expect(body.resolutionCommit).toBe(
      "cafef00dcafef00dcafef00dcafef00dcafef00d"
    );
  });
});

describe("POST /api/v1/agents/:id/persona-reviews/:personaAgentId/resolution", () => {
  async function seed(
    opts: { reviewStatus?: "reviewing" | "complete" } = {}
  ): Promise<{ parentId: string; childId: string; reviewId: number }> {
    const parentId = await insertAgent();
    const childId = await insertAgent({
      parentAgentId: parentId,
      persona: "security-review",
    });
    const reviewId = await insertPersonaReview(
      childId,
      parentId,
      opts.reviewStatus ?? "complete"
    );
    return { parentId, childId, reviewId };
  }

  it("rejects an empty summary with 400", async () => {
    const { parentId, childId } = await seed();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/summary is required/i);
  });

  it("rejects a whitespace-only summary with 400", async () => {
    const { parentId, childId } = await seed();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "   \n" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/summary is required/i);
  });

  it("rejects non-string summary with 400", async () => {
    const { parentId, childId } = await seed();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/summary is required/i);
  });

  it("rejects with 409 when feedback items are still open", async () => {
    const { parentId, childId } = await seed();
    const openId = await insertFeedback(childId, "still open");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "I addressed some of it." },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(
      new RegExp(`feedback items still open: ${openId}`)
    );
  });

  it("rejects with 409 when an ignored item is missing a reason", async () => {
    const { parentId, childId } = await seed();
    const feedbackId = await insertFeedback(childId);
    // Mark ignored in the DB without a reason to simulate bypassing the
    // resolve tool's guard.
    await pool.query(
      "UPDATE agent_feedback SET status = 'ignored', resolution_reason = NULL WHERE id = $1",
      [feedbackId]
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "Covered the rest." },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(
      new RegExp(`ignored feedback items missing a reason: ${feedbackId}`)
    );
  });

  it("rejects with 409 when the review is not in 'complete' state", async () => {
    const { parentId, childId } = await seed({ reviewStatus: "reviewing" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "Something." },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/must be in status 'complete'/);
  });

  it("returns 404 when the parent agent does not exist", async () => {
    const parentId = "agt_000000000000";
    const childId = await insertAgent({ persona: "security-review" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "whatever" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/Agent not found/i);
  });

  it("persists summary + HEAD sha on the happy path", async () => {
    const { parentId, childId, reviewId } = await seed();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { summary: "Fixed 2, rejected 1 with reasons." },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.resolution.summary).toBe("Fixed 2, rejected 1 with reasons.");
    expect(body.resolution.resolutionCommit).toBe(mockState.headSha);
    expect(body.resolution.roundNumber).toBe(1);
    expect(body.resolution.reviewId).toBe(reviewId);

    // Confirm row is actually persisted.
    const dbRows = await pool.query(
      "SELECT summary, resolution_commit, round_number FROM persona_review_resolutions WHERE review_id = $1",
      [reviewId]
    );
    expect(dbRows.rowCount).toBe(1);
    expect(dbRows.rows[0].summary).toBe("Fixed 2, rejected 1 with reasons.");
    expect(dbRows.rows[0].resolution_commit).toBe(mockState.headSha);
    expect(dbRows.rows[0].round_number).toBe(1);
  });

  it("requires authentication", async () => {
    const { parentId, childId } = await seed();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${parentId}/persona-reviews/${childId}/resolution`,
      headers: { "content-type": "application/json" },
      payload: { summary: "anything" },
    });

    expect(response.statusCode).toBe(401);
  });
});
