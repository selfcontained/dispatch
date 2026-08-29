import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp();
let authToken: string;

beforeEach(async () => {
  if (!authToken) {
    const tokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    authToken = tokenResult.rows[0]!.value;
  }
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agent_token_usage");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM sessions");
});

function mcpRequest(
  url: string,
  token: string,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown> = {}
) {
  return ctx.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

function parseToolText(body: string): string {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const message = JSON.parse(line.slice(6)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = message.result?.content?.[0]?.text;
    if (text) return text;
  }
  throw new Error("No tool result text found in response body");
}

describe("MCP login-link tool", () => {
  it("does not expose or invoke the tool on the root MCP endpoint", async () => {
    const listed = await mcpRequest("/api/mcp", authToken, "tools/list");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('"name":"dispatch_login_link"');

    const called = await mcpRequest("/api/mcp", authToken, "tools/call", {
      name: "dispatch_login_link",
      arguments: {},
    });
    expect(called.statusCode).toBe(200);
    expect(called.body).toContain('"isError":true');
    expect(called.body).toMatch(/tool.*dispatch_login_link.*not found/i);
  });

  it("lists and issues a 60-second login link for agent-scoped callers", async () => {
    const agentId = "agt_login_link_agent";
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, full_access)
       VALUES ($1, 'login-link-agent', 'codex', 'standard', 'running', '/tmp', false)`,
      [agentId]
    );

    const agentToken = ctx.auth.createAgentMcpToken(authToken, agentId);
    const listed = await mcpRequest(
      `/api/mcp/${agentId}`,
      agentToken,
      "tools/list"
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain('"name":"dispatch_login_link"');

    const issued = await mcpRequest(
      `/api/mcp/${agentId}`,
      agentToken,
      "tools/call",
      { name: "dispatch_login_link", arguments: {} }
    );
    expect(issued.statusCode).toBe(200);
    const result = JSON.parse(parseToolText(issued.body)) as {
      token: string;
      path: string;
      expiresInSeconds: number;
    };
    expect(result).toMatchObject({
      token: expect.any(String),
      expiresInSeconds: 60,
    });
    expect(result.token).not.toHaveLength(0);
    expect(result.path).toBe(`/login#login-link=${result.token}`);

    const exchanged = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login-links/exchange",
      payload: { token: result.token },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toEqual({ ok: true });
    expect(exchanged.headers["set-cookie"]).toContain("dispatch_session=");

    const reused = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login-links/exchange",
      payload: { token: result.token },
    });
    expect(reused.statusCode).toBe(401);
  });

  it("lists the tool for review agents but not job-scoped MCP callers", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, persona, full_access)
       VALUES
       ('agt_login_link_review', 'reviewer', 'codex', 'review', 'running', '/tmp', 'security-review', false),
       ('agt_login_link_job', 'job', 'codex', 'standard', 'running', '/tmp', null, false)`
    );
    await ctx.pool.query(
      `INSERT INTO jobs (
         id, directory, name, enabled, agent_type, use_worktree, full_access,
         schedule, timeout_ms, needs_input_timeout_ms, auto_archive
       ) VALUES (
         'job_login_link', '/tmp', 'Login Link Job', true, 'codex', false, false,
         null, 1800000, 1800000, true
       )`
    );
    await ctx.pool.query(
      `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
       VALUES ('run_login_link', 'job_login_link', 'running', NOW(), NOW(), 'agt_login_link_job')`
    );

    const review = await mcpRequest(
      "/api/mcp/agt_login_link_review",
      ctx.auth.createAgentMcpToken(authToken, "agt_login_link_review"),
      "tools/list"
    );
    expect(review.statusCode).toBe(200);
    expect(review.body).toContain('"name":"dispatch_login_link"');

    const job = await mcpRequest(
      "/api/mcp/jobs/run_login_link/agt_login_link_job",
      ctx.auth.createJobMcpToken(
        authToken,
        "run_login_link",
        "agt_login_link_job"
      ),
      "tools/list"
    );
    expect(job.statusCode).toBe(200);
    expect(job.body).not.toContain('"name":"dispatch_login_link"');

    await ctx.pool.query(
      "UPDATE job_runs SET status = 'timed_out' WHERE id = 'run_login_link'"
    );
    const completedJob = await mcpRequest(
      "/api/mcp/jobs/run_login_link/agt_login_link_job",
      ctx.auth.createJobMcpToken(
        authToken,
        "run_login_link",
        "agt_login_link_job"
      ),
      "tools/list"
    );
    expect(completedJob.statusCode).toBe(200);
    expect(completedJob.body).not.toContain('"name":"dispatch_login_link"');
  });
});
