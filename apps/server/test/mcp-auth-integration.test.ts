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

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

let pool: Pool;
let app: FastifyInstance;
let createAgentMcpToken: typeof import("../src/auth.js").createAgentMcpToken;
let createJobMcpToken: typeof import("../src/auth.js").createJobMcpToken;
let createSession: typeof import("../src/auth.js").createSession;
let sessionCookie: string;

// fastify's `app.inject()` gives the MCP route a LightMyRequest MockSocket
// that lacks `destroySoon`. @hono/node-server (used internally by the MCP
// SDK's StreamableHTTP transport) schedules an unref'd 500ms drain timer
// that calls `socket.destroySoon()`. If the event loop is still alive when
// the timer fires, vitest catches the resulting TypeError as an unhandled
// exception and fails the run. Swallow just that specific teardown error.
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
  process.env.DISPATCH_PORT = "6768";
  process.env.DISPATCH_HOST = "127.0.0.1";

  const auth = await import("../src/auth.js");
  ({ createAgentMcpToken, createJobMcpToken, createSession } = auth);

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
  // Let hono's 500ms drain timer fire (and get swallowed by the filter)
  // before vitest starts tearing the suite down.
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.off("uncaughtException", uncaughtExceptionFilter);
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agent_feedback");
  await pool.query("DELETE FROM persona_reviews");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM agents");
  const session = await createSession(pool);
  const signed = (
    app as FastifyInstance & { signCookie: (value: string) => string }
  ).signCookie(session);
  sessionCookie = `dispatch_session=${signed}`;
});

describe("MCP auth integration", () => {
  it("rejects invalid scoped agent tokens on the real route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_123456abcdef",
      headers: { authorization: "Bearer invalid-token" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Invalid MCP token for the requested agent route.",
    });
  });

  it("rejects invalid scoped job tokens on the real route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_123/agt_123456abcdef",
      headers: { authorization: "Bearer invalid-token" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Invalid MCP token for the requested job agent route.",
    });
  });

  it("accepts session-cookie auth on /api/mcp", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { cookie: sessionCookie },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(406);
    expect(response.body).not.toContain("Authentication required.");
  });

  it("does not treat malformed MCP paths as scoped routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_123456abcdef/extra",
      headers: { authorization: "Bearer invalid-token" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required." });
  });

  it("still allows valid scoped tokens through to real scoped routes", async () => {
    const authTokenResult = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_123456abcdef",
      headers: {
        authorization: `Bearer ${createAgentMcpToken(authToken, "agt_123456abcdef")}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(agentResponse.statusCode).toBe(404);
    expect(agentResponse.json()).toEqual({ error: "Agent not found." });

    const jobResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_123/agt_123456abcdef",
      headers: {
        authorization: `Bearer ${createJobMcpToken(authToken, "run_123", "agt_123456abcdef")}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(jobResponse.statusCode).toBe(404);
    expect(jobResponse.json()).toEqual({ error: "Agent not found." });
  });

  it("never exposes removed await tools and exposes recheck context for recheck-enabled sessions", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parentreview', 'parent', 'codex', 'running', '/tmp', null, null, false),
       ('agt_persona_plain', 'plain-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false),
       ('agt_persona_recheck', 'recheck-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false),
       ('agt_persona_round2', 'round2-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false)`
    );
    await pool.query(
      `INSERT INTO persona_reviews (
          agent_id, parent_agent_id, persona, status, round_number, allow_recheck
        )
        VALUES
        ('agt_persona_plain', 'agt_parentreview', 'backend-security-review', 'reviewing', 1, false),
        ('agt_persona_recheck', 'agt_parentreview', 'backend-security-review', 'reviewing', 1, true),
        ('agt_persona_round2', 'agt_parentreview', 'backend-security-review', 'awaiting_recheck', 1, true)`
    );

    const authTokenResult = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const parentResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_parentreview",
      headers: {
        authorization: `Bearer ${createAgentMcpToken(authToken, "agt_parentreview")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(parentResponse.statusCode).toBe(200);
    expect(parentResponse.body).not.toContain("dispatch_await_review");
    expect(parentResponse.body).not.toContain("dispatch_await_recheck");

    for (const personaAgentId of ["agt_persona_plain", "agt_persona_recheck"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/mcp/${personaAgentId}`,
        headers: {
          authorization: `Bearer ${createAgentMcpToken(authToken, personaAgentId)}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("dispatch_await_recheck");
      expect(response.body).not.toContain("dispatch_await_review");
      if (personaAgentId === "agt_persona_plain") {
        expect(response.body).not.toContain("dispatch_get_recheck_context");
      } else {
        expect(response.body).toContain("dispatch_get_recheck_context");
      }
    }

    const round2Response = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_round2",
      headers: {
        authorization: `Bearer ${createAgentMcpToken(authToken, "agt_persona_round2")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(round2Response.statusCode).toBe(200);
    expect(round2Response.body).toContain("dispatch_get_recheck_context");
    expect(round2Response.body).not.toContain("dispatch_await_recheck");
    expect(round2Response.body).not.toContain("dispatch_await_review");
  });

  it("only returns authoritative recheck diff metadata while round 2 is ready", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parent_ctx', 'parent', 'codex', 'running', '/tmp', null, null, false),
       ('agt_persona_waiting', 'waiting-reviewer', 'codex', 'running', '/tmp', 'architecture-review', 'agt_parent_ctx', false),
       ('agt_persona_ready', 'ready-reviewer', 'codex', 'running', '/tmp', 'architecture-review', 'agt_parent_ctx', false),
       ('agt_persona_complete', 'complete-reviewer', 'codex', 'running', '/tmp', 'architecture-review', 'agt_parent_ctx', false)`
    );
    const baseWait = "1111111111111111111111111111111111111111";
    const headWait = "2222222222222222222222222222222222222222";
    const baseReady = "3333333333333333333333333333333333333333";
    const headReady = "4444444444444444444444444444444444444444";
    const baseComplete = "5555555555555555555555555555555555555555";
    const headComplete = "6666666666666666666666666666666666666666";
    await pool.query(
      `INSERT INTO persona_reviews (
          id, agent_id, parent_agent_id, persona, status, round_number, allow_recheck, last_reviewed_commit
        )
        VALUES
        (9001, 'agt_persona_waiting', 'agt_parent_ctx', 'architecture-review', 'reviewing', 1, true, $1),
        (9002, 'agt_persona_ready', 'agt_parent_ctx', 'architecture-review', 'awaiting_recheck', 1, true, $2),
        (9003, 'agt_persona_complete', 'agt_parent_ctx', 'architecture-review', 'complete', 2, true, $3)`,
      [baseWait, baseReady, baseComplete]
    );
    await pool.query(
      `INSERT INTO persona_review_resolutions (
          review_id, summary, resolution_commit, round_number, submitted_at
        )
        VALUES
        (9001, 'Waiting summary', $1, 1, NOW()),
        (9002, 'Ready summary', $2, 1, NOW()),
        (9003, 'Complete summary', $3, 1, NOW())`,
      [headWait, headReady, headComplete]
    );

    const authTokenResult = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    for (const [agentId, expectedAvailability, compareRange] of [
      ["agt_persona_waiting", "waiting_for_resolution", null],
      ["agt_persona_ready", "ready", `${baseReady}...${headReady}`],
      ["agt_persona_complete", "complete", null],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/mcp/${agentId}`,
        headers: {
          authorization: `Bearer ${createAgentMcpToken(authToken, agentId)}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "dispatch_get_recheck_context",
            arguments: {},
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `"availability":"${expectedAvailability}"`
      );
      if (compareRange) {
        expect(response.body).toContain(`"compareRange":"${compareRange}"`);
        expect(response.body).toContain(
          `"gitDiffCommand":"git diff ${compareRange}"`
        );
      } else {
        expect(response.body).toContain('"compareRange":null');
        expect(response.body).toContain('"gitDiffCommand":null');
      }
    }
  });

  it("nulls compareRange when stored commits are not git-SHA-shaped", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parent_bad', 'parent', 'codex', 'running', '/tmp', null, null, false),
       ('agt_persona_bad', 'reviewer', 'codex', 'running', '/tmp', 'architecture-review', 'agt_parent_bad', false)`
    );
    await pool.query(
      `INSERT INTO persona_reviews (
          id, agent_id, parent_agent_id, persona, status, round_number, allow_recheck, last_reviewed_commit
        )
        VALUES
        (9101, 'agt_persona_bad', 'agt_parent_bad', 'architecture-review', 'awaiting_recheck', 1, true, 'not a sha; rm -rf /')`
    );
    await pool.query(
      `INSERT INTO persona_review_resolutions (
          review_id, summary, resolution_commit, round_number, submitted_at
        )
        VALUES
        (9101, 'Bad summary', 'also$(evil)', 1, NOW())`
    );

    const authTokenResult = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_bad",
      headers: {
        authorization: `Bearer ${createAgentMcpToken(authToken, "agt_persona_bad")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dispatch_get_recheck_context", arguments: {} },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"availability":"ready"');
    expect(response.body).toContain('"compareRange":null');
    expect(response.body).toContain('"gitDiffCommand":null');
  });

  it("exposes dispatch_event and dispatch_rename_session on the job-scoped MCP route", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, full_access)
       VALUES ('agt_jobrename', 'job-rename-test', 'codex', 'running', '/tmp', false)`
    );
    await pool.query(
      `INSERT INTO jobs (
          id, directory, name, enabled, agent_type, use_worktree, full_access,
          schedule, timeout_ms, needs_input_timeout_ms, auto_archive
        )
        VALUES (
          'job_rename', '/tmp', 'Rename Job', true, 'codex', false, false,
          null, 1800000, 1800000, true
        )`
    );
    await pool.query(
      `INSERT INTO job_runs (
          id, job_id, status, started_at, status_updated_at, agent_id
        )
        VALUES (
          'run_jobrename', 'job_rename', 'running', NOW(), NOW(), 'agt_jobrename'
        )`
    );

    const authTokenResult = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_jobrename/agt_jobrename",
      headers: {
        authorization: `Bearer ${createJobMcpToken(authToken, "run_jobrename", "agt_jobrename")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dispatch_event");
    expect(response.body).toContain("dispatch_rename_session");
  });
});
