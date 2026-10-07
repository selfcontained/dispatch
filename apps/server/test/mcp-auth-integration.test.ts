import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp();
let sessionCookie: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_token_usage");
  await ctx.pool.query("DELETE FROM files_seen");
  await ctx.pool.query("DELETE FROM files");
  await ctx.pool.query("DELETE FROM sessions");
  await ctx.pool.query("DELETE FROM agents");
  sessionCookie = await ctx.sessionCookie();
});

describe("MCP auth integration", () => {
  it("uploads, lists, and reads shared files through real MCP calls, including useful errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-mcp-files-"));
    const parent = "agt_files_parent";
    const child = "agt_files_child";
    const stranger = "agt_files_stranger";
    try {
      for (const id of [parent, child, stranger]) {
        await ctx.pool.query(
          `INSERT INTO agents (id, name, type, status, cwd, files_dir, parent_agent_id)
           VALUES ($1, $1, 'codex', 'running', $2, $3, $4)`,
          [id, dir, path.join(dir, id), id === child ? parent : null]
        );
      }
      const token = (
        await ctx.pool.query<{ value: string }>(
          "SELECT value FROM settings WHERE key = 'auth_token'"
        )
      ).rows[0]!.value;
      const call = async (
        agentId: string,
        name: string,
        args: Record<string, unknown>
      ) => {
        const response = await ctx.app.inject({
          method: "POST",
          url: `/api/mcp/${agentId}`,
          headers: {
            authorization: `Bearer ${ctx.auth.createAgentMcpToken(token, agentId)}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
        });
        expect(response.statusCode).toBe(200);
        const data = response.body
          .split("\n")
          .find((line) => line.startsWith("data: "));
        const body = JSON.parse(data ? data.slice(6) : response.body);
        expect(body.error).toBeUndefined();
        return body.result as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };
      };
      const source = path.join(dir, "review notes.txt");
      await writeFile(source, "Review attachment round trip.\n");
      expect(
        await call(child, "post", {
          attachments: [{ type: "file", path: source }],
        })
      ).not.toHaveProperty("isError", true);

      const own = await call(child, "list_files", {});
      expect(own.isError).not.toBe(true);
      const files = JSON.parse(own.content[0]!.text);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ ownerAgentId: child, source: "text" });
      expect(await readFile(files[0].filePath, "utf8")).toBe(
        "Review attachment round trip.\n"
      );
      const family = await call(parent, "list_files", { ownerAgentId: child });
      expect(JSON.parse(family.content[0]!.text)).toEqual(files);
      const filtered = await call(parent, "list_files", {
        ownerAgentId: child,
        source: "screenshot",
      });
      expect(JSON.parse(filtered.content[0]!.text)).toEqual([]);
      // The review reader is callable through the same scoped MCP route.
      const posted = await call(child, "post", {
        to: parent,
        review: { summary: "Files checked.", findings: [] },
      });
      expect(posted.isError).not.toBe(true);
      const reviewId = JSON.parse(posted.content[0]!.text).id;
      const fetched = await call(parent, "get_review", {});
      expect(fetched.isError).not.toBe(true);
      expect(JSON.parse(fetched.content[0]!.text)).toMatchObject({
        id: reviewId,
        summary: "Files checked.",
        status: "complete",
        findings: [],
      });
      expect(
        await call(stranger, "get_review", { id: reviewId })
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Review not found." }],
      });

      // An archive must not make a child's reports unreadable.
      await ctx.pool.query(
        "UPDATE agents SET deleted_at = NOW() WHERE id = $1",
        [child]
      );
      expect(
        JSON.parse(
          (await call(parent, "list_files", { ownerAgentId: child }))
            .content[0]!.text
        )
      ).toEqual(files);
      const forbidden = await call(stranger, "list_files", {
        ownerAgentId: child,
      });
      expect(forbidden).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Agent not found." }],
      });

      const missing = path.join(dir, "missing.txt");
      const failed = await call(parent, "post", {
        attachments: [{ type: "file", path: missing }],
      });
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain("ENOENT");
      expect(failed.content[0]!.text).toContain("missing.txt");
      expect(
        JSON.parse((await call(parent, "list_files", {})).content[0]!.text)
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it("does not infer review tools from persona metadata", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, persona, parent_agent_id, full_access)
       VALUES ('agt_persona_standard', 'specialist', 'codex', 'standard', 'running', '/tmp', 'architecture-guide', null, false)`
    );
    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_persona_standard",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authTokenResult.rows[0]!.value, "agt_persona_standard")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("rename_session");
    expect(response.body).toContain("get_review");
    expect(response.body).not.toContain('"name":"review_submit"');
  });

  it("exposes lifecycle and persona tools on the job-scoped MCP route", async () => {
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
    expect(response.body).toContain("rename_session");
    expect(response.body).toContain("rename_session");
    expect(response.body).toContain("list_files");
    expect(response.body).toContain("get_review");
    expect(response.body).toContain("list_personas");
    expect(response.body).toContain("launch_agent");
    expect(response.body).toContain("launch_owner_reviews");
    expect(response.body).not.toContain("launch_persona");
    expect(response.body).not.toContain("review_submit");
    expect(response.body).not.toContain("dispatch_submit_resolution");
    expect(response.body).not.toContain("dispatch_cancel_recheck");
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
    expect(response.body).toContain("rename_session");
    expect(response.body).toContain('"post"');
    expect(response.body).not.toContain("share_file");
    expect(response.body).toContain("launch_agent");
    expect(response.body).toContain("launch_owner_reviews");
    expect(response.body).not.toContain("job_complete");
    expect(response.body).not.toContain("job_log");
    expect(response.body).not.toContain("job_failed");
    expect(response.body).not.toContain("job_needs_input");
  });
});
