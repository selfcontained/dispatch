import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp();
let sessionCookie: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_token_usage");
  await ctx.pool.query("DELETE FROM agent_feedback");
  await ctx.pool.query("DELETE FROM persona_reviews");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM media_seen");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM sessions");
  await ctx.pool.query("DELETE FROM agents");
  sessionCookie = await ctx.sessionCookie();
});

describe("MCP auth integration", () => {
  it("rejects invalid scoped agent tokens on the real route", async () => {
    const response = await ctx.app.inject({
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
    const response = await ctx.app.inject({
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
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { cookie: sessionCookie },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(406);
    expect(response.body).not.toContain("Authentication required.");
  });

  it("does not treat malformed MCP paths as scoped routes", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_123456abcdef/extra",
      headers: { authorization: "Bearer invalid-token" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required." });
  });

  it("still allows valid scoped tokens through to real scoped routes", async () => {
    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const agentResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_123456abcdef",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_123456abcdef")}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(agentResponse.statusCode).toBe(404);
    expect(agentResponse.json()).toEqual({ error: "Agent not found." });

    const jobResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_123/agt_123456abcdef",
      headers: {
        authorization: `Bearer ${ctx.auth.createJobMcpToken(authToken, "run_123", "agt_123456abcdef")}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(jobResponse.statusCode).toBe(404);
    expect(jobResponse.json()).toEqual({ error: "Agent not found." });
  });

  it("never exposes removed await tools and exposes recheck context for all persona sessions", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parentreview', 'parent', 'codex', 'running', '/tmp', null, null, false),
       ('agt_persona_plain', 'plain-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false),
       ('agt_persona_recheck', 'recheck-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false),
       ('agt_persona_round2', 'round2-reviewer', 'codex', 'running', '/tmp', 'backend-security-review', 'agt_parentreview', false)`
    );
    await ctx.pool.query(
      `INSERT INTO persona_reviews (
          agent_id, parent_agent_id, persona, status, round_number, allow_recheck
        )
        VALUES
        ('agt_persona_plain', 'agt_parentreview', 'backend-security-review', 'reviewing', 1, true),
        ('agt_persona_recheck', 'agt_parentreview', 'backend-security-review', 'reviewing', 1, true),
        ('agt_persona_round2', 'agt_parentreview', 'backend-security-review', 'awaiting_recheck', 1, true)`
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const parentResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_parentreview",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_parentreview")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(parentResponse.statusCode).toBe(200);
    expect(parentResponse.body).not.toContain("dispatch_await_review");
    expect(parentResponse.body).not.toContain("dispatch_await_recheck");

    for (const personaAgentId of ["agt_persona_plain", "agt_persona_recheck"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/mcp/${personaAgentId}`,
        headers: {
          authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, personaAgentId)}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("dispatch_await_recheck");
      expect(response.body).not.toContain("dispatch_await_review");
      expect(response.body).toContain("dispatch_get_recheck_context");
    }

    const round2Response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_round2",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_persona_round2")}`,
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

  it("exposes dispatch_send_message to Cursor persona sessions only", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parent_send', 'parent', 'cursor', 'running', '/tmp', null, null, false),
       ('agt_persona_cursor_send', 'cursor-reviewer', 'cursor', 'running', '/tmp', 'mobile-ux-review', 'agt_parent_send', false),
       ('agt_persona_codex_send', 'codex-reviewer', 'codex', 'running', '/tmp', 'mobile-ux-review', 'agt_parent_send', false)`
    );
    await ctx.pool.query(
      `INSERT INTO persona_reviews (
          agent_id, parent_agent_id, persona, status, round_number, allow_recheck
        )
        VALUES
        ('agt_persona_cursor_send', 'agt_parent_send', 'mobile-ux-review', 'complete', 2, true),
        ('agt_persona_codex_send', 'agt_parent_send', 'mobile-ux-review', 'complete', 2, true)`
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const cursorResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_cursor_send",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_persona_cursor_send")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(cursorResponse.statusCode).toBe(200);
    expect(cursorResponse.body).toContain("dispatch_send_message");
    expect(cursorResponse.body).toContain("agt_parent_send");

    const disallowedTargetResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_cursor_send",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_persona_cursor_send")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_send_message",
          arguments: {
            target: "agt_persona_codex_send",
            message: "Not for sibling reviewers",
          },
        },
      },
    });
    expect(disallowedTargetResponse.statusCode).toBe(200);
    expect(disallowedTargetResponse.body).toContain(
      "dispatch_send_message target must be one of: agt_parent_send"
    );

    const codexResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_codex_send",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_persona_codex_send")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(codexResponse.statusCode).toBe(200);
    expect(codexResponse.body).not.toContain("dispatch_send_message");
  });

  it("only returns authoritative recheck diff metadata while round 2 is ready", async () => {
    await ctx.pool.query(
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
    await ctx.pool.query(
      `INSERT INTO persona_reviews (
          id, agent_id, parent_agent_id, persona, status, round_number, allow_recheck, last_reviewed_commit
        )
        VALUES
        (9001, 'agt_persona_waiting', 'agt_parent_ctx', 'architecture-review', 'reviewing', 1, true, $1),
        (9002, 'agt_persona_ready', 'agt_parent_ctx', 'architecture-review', 'awaiting_recheck', 1, true, $2),
        (9003, 'agt_persona_complete', 'agt_parent_ctx', 'architecture-review', 'complete', 2, true, $3)`,
      [baseWait, baseReady, baseComplete]
    );
    await ctx.pool.query(
      `INSERT INTO persona_review_resolutions (
          review_id, summary, resolution_commit, round_number, submitted_at
        )
        VALUES
        (9001, 'Waiting summary', $1, 1, NOW()),
        (9002, 'Ready summary', $2, 1, NOW()),
        (9003, 'Complete summary', $3, 1, NOW())`,
      [headWait, headReady, headComplete]
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    for (const [agentId, expectedAvailability, compareRange] of [
      ["agt_persona_waiting", "waiting_for_resolution", null],
      ["agt_persona_ready", "ready", `${baseReady}...${headReady}`],
      ["agt_persona_complete", "complete", null],
    ] as const) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/mcp/${agentId}`,
        headers: {
          authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, agentId)}`,
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
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
       VALUES
       ('agt_parent_bad', 'parent', 'codex', 'running', '/tmp', null, null, false),
       ('agt_persona_bad', 'reviewer', 'codex', 'running', '/tmp', 'architecture-review', 'agt_parent_bad', false)`
    );
    await ctx.pool.query(
      `INSERT INTO persona_reviews (
          id, agent_id, parent_agent_id, persona, status, round_number, allow_recheck, last_reviewed_commit
        )
        VALUES
        (9101, 'agt_persona_bad', 'agt_parent_bad', 'architecture-review', 'awaiting_recheck', 1, true, 'not a sha; rm -rf /')`
    );
    await ctx.pool.query(
      `INSERT INTO persona_review_resolutions (
          review_id, summary, resolution_commit, round_number, submitted_at
        )
        VALUES
        (9101, 'Bad summary', 'also$(evil)', 1, NOW())`
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_bad",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_persona_bad")}`,
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

  it("exposes dispatch_event, rename, and the persona review/recheck flow on the job-scoped MCP route", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, full_access)
       VALUES ('agt_jobrename', 'job-rename-test', 'codex', 'running', '/tmp', false)`
    );
    await ctx.pool.query(
      `INSERT INTO jobs (
          id, directory, name, enabled, agent_type, use_worktree, full_access,
          schedule, timeout_ms, needs_input_timeout_ms, auto_archive
        )
        VALUES (
          'job_rename', '/tmp', 'Rename Job', true, 'codex', false, false,
          null, 1800000, 1800000, true
        )`
    );
    await ctx.pool.query(
      `INSERT INTO job_runs (
          id, job_id, status, started_at, status_updated_at, agent_id
        )
        VALUES (
          'run_jobrename', 'job_rename', 'running', NOW(), NOW(), 'agt_jobrename'
        )`
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_jobrename/agt_jobrename",
      headers: {
        authorization: `Bearer ${ctx.auth.createJobMcpToken(authToken, "run_jobrename", "agt_jobrename")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dispatch_event");
    expect(response.body).toContain("dispatch_rename_session");
    expect(response.body).toContain("dispatch_list_media");
    expect(response.body).toContain("list_personas");
    expect(response.body).toContain("dispatch_launch_persona");
    expect(response.body).toContain("dispatch_get_feedback");
    expect(response.body).toContain("dispatch_resolve_feedback");
    expect(response.body).toContain("dispatch_submit_resolution");
    expect(response.body).toContain("dispatch_cancel_recheck");
    expect(response.body).toContain("job_complete");
    expect(response.body).toContain("job_log");
  });

  it("keeps the job MCP route usable after the run terminates, switching to agent tools", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, full_access)
       VALUES ('agt_postrun', 'post-run-test', 'codex', 'running', '/tmp', false)`
    );
    await ctx.pool.query(
      `INSERT INTO jobs (
          id, directory, name, enabled, agent_type, use_worktree, full_access,
          schedule, timeout_ms, needs_input_timeout_ms, auto_archive
        )
        VALUES (
          'job_postrun', '/tmp', 'Post Run Job', true, 'codex', false, false,
          null, 1800000, 1800000, false
        )`
    );
    await ctx.pool.query(
      `INSERT INTO job_runs (
          id, job_id, status, started_at, status_updated_at, agent_id
        )
        VALUES (
          'run_postrun', 'job_postrun', 'timed_out', NOW(), NOW(), 'agt_postrun'
        )`
    );

    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_postrun/agt_postrun",
      headers: {
        authorization: `Bearer ${ctx.auth.createJobMcpToken(authToken, "run_postrun", "agt_postrun")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dispatch_event");
    expect(response.body).toContain("dispatch_share");
    expect(response.body).toContain("dispatch_launch_persona");
    expect(response.body).not.toContain("job_complete");
    expect(response.body).not.toContain("job_log");
    expect(response.body).not.toContain("job_failed");
    expect(response.body).not.toContain("job_needs_input");
  });
});
