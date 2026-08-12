import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp();
let sessionCookie: string;
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
  await ctx.pool.query("DELETE FROM templates");
  await ctx.pool.query("DELETE FROM agent_token_usage");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM media_seen");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM sessions");
  sessionCookie = await ctx.sessionCookie();
});

async function mcpToolsList(url: string, token: string) {
  return ctx.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

async function mcpToolCall(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>
) {
  return ctx.app.inject({
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
      params: { name: toolName, arguments: args },
    },
  });
}

async function mcpJobToolCall(
  runId: string,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>
) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/mcp/jobs/${runId}/${agentId}`,
    headers: {
      authorization: `Bearer ${ctx.auth.createJobMcpToken(authToken, runId, agentId)}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
  });
}

function parseToolText(body: string): string {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6));
      const text = json.result?.content?.[0]?.text;
      if (text) return text;
    } catch {}
  }
  throw new Error("No tool result text found in response body");
}

const CRUD_TOOL_NAMES = [
  "list_jobs",
  "get_job",
  "create_job",
  "update_job",
  "delete_job",
  "run_job",
  "list_templates",
  "get_template",
  "create_template",
  "update_template",
  "delete_template",
];

describe("MCP CRUD tools", () => {
  // ── Tool gating ─────────────────────────────────────────────────
  describe("tool gating", () => {
    it("exposes CRUD tools for regular agents", async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ('agt_crud_agent', 'crud-agent', 'claude', 'running', '/tmp', false)`
      );

      const response = await mcpToolsList(
        "/api/mcp/agt_crud_agent",
        ctx.auth.createAgentMcpToken(authToken, "agt_crud_agent")
      );

      expect(response.statusCode).toBe(200);
      for (const tool of CRUD_TOOL_NAMES) {
        expect(response.body).toContain(tool);
      }
    });

    it("exposes CRUD tools for job agents", async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ('agt_crud_job', 'crud-job', 'claude', 'running', '/tmp', false)`
      );
      await ctx.pool.query(
        `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
         VALUES ('job_crud', '/tmp', 'CRUD Job', false, 'claude', false, false, null, 1800000, 1800000, true)`
      );
      await ctx.pool.query(
        `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
         VALUES ('run_crud', 'job_crud', 'running', NOW(), NOW(), 'agt_crud_job')`
      );

      const response = await mcpToolsList(
        "/api/mcp/jobs/run_crud/agt_crud_job",
        ctx.auth.createJobMcpToken(authToken, "run_crud", "agt_crud_job")
      );

      expect(response.statusCode).toBe(200);
      for (const tool of CRUD_TOOL_NAMES) {
        expect(response.body).toContain(tool);
      }
    });

    it("does NOT expose CRUD tools for review agents", async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, role, status, cwd, persona, parent_agent_id, full_access)
         VALUES
         ('agt_crud_parent', 'parent', 'claude', 'standard', 'running', '/tmp', null, null, false),
         ('agt_crud_persona', 'persona', 'claude', 'review', 'running', '/tmp', 'security-review', 'agt_crud_parent', false)`
      );
      const response = await mcpToolsList(
        "/api/mcp/agt_crud_persona",
        ctx.auth.createAgentMcpToken(authToken, "agt_crud_persona")
      );

      expect(response.statusCode).toBe(200);
      for (const tool of CRUD_TOOL_NAMES) {
        expect(response.body).not.toContain(`"${tool}"`);
      }
    });
  });

  // ── Job-scoped route CRUD ────────────────────────────────────────
  describe("job-scoped route CRUD", () => {
    const agentId = "agt_jobscope_crud";
    const runId = "run_jobscope";

    beforeEach(async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ($1, 'jobscope-crud', 'claude', 'running', '/tmp', false)`,
        [agentId]
      );
      await ctx.pool.query(
        `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
         VALUES ('job_scope', '/tmp', 'Scope Job', false, 'claude', false, false, null, 1800000, 1800000, true)`
      );
      await ctx.pool.query(
        `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
         VALUES ($1, 'job_scope', 'running', NOW(), NOW(), $2)`,
        [runId, agentId]
      );
    });

    it("creates and gets a job via the job-scoped route", async () => {
      const createRes = await mcpJobToolCall(runId, agentId, "create_job", {
        name: "job-route-test",
        directory: "/tmp",
        prompt: "Created via job route",
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(parseToolText(createRes.body));
      expect(created.name).toBe("job-route-test");
      expect(created.id).toBeTruthy();

      const getRes = await mcpJobToolCall(runId, agentId, "get_job", {
        jobId: created.id,
      });
      expect(getRes.statusCode).toBe(200);
      const got = JSON.parse(parseToolText(getRes.body));
      expect(got.name).toBe("job-route-test");

      const deleteRes = await mcpJobToolCall(runId, agentId, "delete_job", {
        name: "job-route-test",
        directory: "/tmp",
      });
      expect(deleteRes.statusCode).toBe(200);
      const deleted = JSON.parse(parseToolText(deleteRes.body));
      expect(deleted.id).toBe(created.id);
    });

    it("rejects job-scoped CRUD calls with an invalid token", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/mcp/jobs/${runId}/${agentId}`,
        headers: {
          authorization: `Bearer bad-token`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_jobs", arguments: {} },
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Job CRUD ────────────────────────────────────────────────────
  describe("job CRUD", () => {
    const agentId = "agt_job_crud";

    beforeEach(async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ($1, 'job-crud-test', 'claude', 'running', '/tmp', false)`,
        [agentId]
      );
    });

    it("creates, lists, gets, updates, and deletes a job", async () => {
      // create_job
      const createRes = await mcpToolCall(agentId, "create_job", {
        name: "test-job",
        directory: "/tmp",
        prompt: "Do a thing",
      });
      expect(createRes.statusCode).toBe(200);
      const createText = parseToolText(createRes.body);
      const created = JSON.parse(createText);
      expect(created.name).toBe("test-job");
      expect(created.directory).toBe("/tmp");
      expect(created.id).toBeTruthy();

      // list_jobs — scoped to /tmp
      const listRes = await mcpToolCall(agentId, "list_jobs", {
        directory: "/tmp",
      });
      expect(listRes.statusCode).toBe(200);
      const listText = parseToolText(listRes.body);
      const jobs = JSON.parse(listText);
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs.some((j: { name: string }) => j.name === "test-job")).toBe(
        true
      );

      // A job listing carries neither the prompt body nor the webhook secret;
      // get_job is the full record.
      const listedJob = jobs.find(
        (j: { name: string }) => j.name === "test-job"
      );
      expect(listedJob.prompt).toBeUndefined();
      expect(listedJob.promptChars).toBe("Do a thing".length);
      expect("webhookSecret" in listedJob).toBe(false);

      // list_jobs — different directory returns empty
      const listOtherRes = await mcpToolCall(agentId, "list_jobs", {
        directory: "/nonexistent",
      });
      expect(listOtherRes.statusCode).toBe(200);
      const otherJobs = JSON.parse(parseToolText(listOtherRes.body));
      expect(otherJobs).toHaveLength(0);

      // get_job by name
      const getByNameRes = await mcpToolCall(agentId, "get_job", {
        name: "test-job",
        directory: "/tmp",
      });
      expect(getByNameRes.statusCode).toBe(200);
      const gotByName = JSON.parse(parseToolText(getByNameRes.body));
      expect(gotByName.id).toBe(created.id);

      // get_job by ID
      const getByIdRes = await mcpToolCall(agentId, "get_job", {
        jobId: created.id,
      });
      expect(getByIdRes.statusCode).toBe(200);
      const gotById = JSON.parse(parseToolText(getByIdRes.body));
      expect(gotById.name).toBe("test-job");

      // update_job
      const updateRes = await mcpToolCall(agentId, "update_job", {
        name: "test-job",
        directory: "/tmp",
        displayName: "renamed-job",
        prompt: "Do a different thing",
      });
      expect(updateRes.statusCode).toBe(200);
      const updated = JSON.parse(parseToolText(updateRes.body));
      expect(updated.name).toBe("renamed-job");

      // delete_job
      const deleteRes = await mcpToolCall(agentId, "delete_job", {
        name: "renamed-job",
        directory: "/tmp",
      });
      expect(deleteRes.statusCode).toBe(200);
      const deleted = JSON.parse(parseToolText(deleteRes.body));
      expect(deleted.id).toBe(created.id);

      // verify it's gone
      const getDeletedRes = await mcpToolCall(agentId, "get_job", {
        jobId: created.id,
      });
      expect(getDeletedRes.statusCode).toBe(200);
      expect(getDeletedRes.body).toContain("not found");
    });

    it("returns error when get_job has neither jobId nor name", async () => {
      const res = await mcpToolCall(agentId, "get_job", {});
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Provide either jobId or name");
    });

    it("returns error when get_job references nonexistent job", async () => {
      const res = await mcpToolCall(agentId, "get_job", {
        name: "does-not-exist",
        directory: "/tmp",
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("not found");
    });
  });

  // ── Template CRUD ───────────────────────────────────────────────
  describe("template CRUD", () => {
    const agentId = "agt_tmpl_crud";

    beforeEach(async () => {
      await ctx.pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ($1, 'tmpl-crud-test', 'claude', 'running', '/tmp', false)`,
        [agentId]
      );
    });

    it("creates, lists, gets, updates, and deletes a template", async () => {
      // create_template
      const createRes = await mcpToolCall(agentId, "create_template", {
        name: "test-template",
        directory: "/tmp",
        prompt: "Hello {{name}}",
        description: "A test template",
      });
      expect(createRes.statusCode).toBe(200);
      const createText = parseToolText(createRes.body);
      const created = JSON.parse(createText);
      expect(created.name).toBe("test-template");
      expect(created.callable).toBe(true);
      expect(created.allowMedia).toBe(true);
      expect(created.id).toBeTruthy();

      // list_templates — scoped to /tmp
      const listRes = await mcpToolCall(agentId, "list_templates", {
        directory: "/tmp",
      });
      expect(listRes.statusCode).toBe(200);
      const templates = JSON.parse(parseToolText(listRes.body));
      expect(Array.isArray(templates)).toBe(true);
      expect(
        templates.some((t: { name: string }) => t.name === "test-template")
      ).toBe(true);

      // list_templates — different directory returns empty
      const listOtherRes = await mcpToolCall(agentId, "list_templates", {
        directory: "/nonexistent",
      });
      expect(listOtherRes.statusCode).toBe(200);
      const otherTemplates = JSON.parse(parseToolText(listOtherRes.body));
      expect(otherTemplates).toHaveLength(0);

      // get_template by name
      const getByNameRes = await mcpToolCall(agentId, "get_template", {
        name: "test-template",
        directory: "/tmp",
      });
      expect(getByNameRes.statusCode).toBe(200);
      const gotByName = JSON.parse(parseToolText(getByNameRes.body));
      expect(gotByName.id).toBe(created.id);

      // get_template by ID
      const getByIdRes = await mcpToolCall(agentId, "get_template", {
        templateId: created.id,
      });
      expect(getByIdRes.statusCode).toBe(200);
      const gotById = JSON.parse(parseToolText(getByIdRes.body));
      expect(gotById.name).toBe("test-template");

      // update_template
      const updateRes = await mcpToolCall(agentId, "update_template", {
        templateId: created.id,
        description: "Updated description",
        callable: false,
      });
      expect(updateRes.statusCode).toBe(200);
      const updated = JSON.parse(parseToolText(updateRes.body));
      expect(updated.description).toBe("Updated description");
      expect(updated.callable).toBe(false);
      // prompt should be unchanged
      expect(updated.prompt).toBe("Hello {{name}}");

      // delete_template
      const deleteRes = await mcpToolCall(agentId, "delete_template", {
        templateId: created.id,
      });
      expect(deleteRes.statusCode).toBe(200);
      const deleted = JSON.parse(parseToolText(deleteRes.body));
      expect(deleted.id).toBe(created.id);

      // verify it's gone
      const getDeletedRes = await mcpToolCall(agentId, "get_template", {
        templateId: created.id,
      });
      expect(getDeletedRes.statusCode).toBe(200);
      expect(getDeletedRes.body).toContain("not found");
    });

    it("reports a template's prompt args so callers know what templateArgs to pass", async () => {
      const created = JSON.parse(
        parseToolText(
          (
            await mcpToolCall(agentId, "create_template", {
              name: "args-template",
              directory: "/tmp",
              prompt: "Review {{D:Target}} for {{D:Concern|required}}.",
            })
          ).body
        )
      );

      const gotById = JSON.parse(
        parseToolText(
          (
            await mcpToolCall(agentId, "get_template", {
              templateId: created.id,
            })
          ).body
        )
      );
      expect(gotById.promptArgs).toEqual([
        expect.objectContaining({ name: "Target", required: false }),
        expect.objectContaining({ name: "Concern", required: true }),
      ]);

      const listed = JSON.parse(
        parseToolText(
          (await mcpToolCall(agentId, "list_templates", { directory: "/tmp" }))
            .body
        )
      ) as Array<{ name: string; promptArgs?: Array<{ name: string }> }>;
      const fromList = listed.find((t) => t.name === "args-template");
      expect(fromList?.promptArgs?.map((a) => a.name)).toEqual([
        "Target",
        "Concern",
      ]);
    });

    it("omits prompt bodies from list_templates, reporting their size instead", async () => {
      const prompt = "P".repeat(4000);
      await mcpToolCall(agentId, "create_template", {
        name: "bulky-template",
        directory: "/tmp",
        prompt,
      });

      const listed = JSON.parse(
        parseToolText(
          (await mcpToolCall(agentId, "list_templates", { directory: "/tmp" }))
            .body
        )
      ) as Array<{ name: string; prompt?: string; promptChars?: number }>;
      const fromList = listed.find((t) => t.name === "bulky-template");
      expect(fromList).toBeTruthy();
      expect(fromList!.prompt).toBeUndefined();
      expect(fromList!.promptChars).toBe(4000);

      // ...and the full prompt is still one get_template away.
      const got = JSON.parse(
        parseToolText(
          (
            await mcpToolCall(agentId, "get_template", {
              name: "bulky-template",
              directory: "/tmp",
            })
          ).body
        )
      );
      expect(got.prompt).toBe(prompt);
    });

    it("omits prompt args for a template with no prompt", async () => {
      const created = JSON.parse(
        parseToolText(
          (
            await mcpToolCall(agentId, "create_template", {
              name: "promptless-template",
              directory: "/tmp",
            })
          ).body
        )
      );

      const got = JSON.parse(
        parseToolText(
          (
            await mcpToolCall(agentId, "get_template", {
              templateId: created.id,
            })
          ).body
        )
      );
      expect(got.prompt).toBeNull();
      expect(got.promptArgs).toBeUndefined();
    });

    it("returns error when get_template has neither templateId nor name", async () => {
      const res = await mcpToolCall(agentId, "get_template", {});
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Provide either templateId or name");
    });

    it("returns error when deleting a template referenced by a job", async () => {
      // Create a job (which auto-creates a backing template)
      const createJobRes = await mcpToolCall(agentId, "create_job", {
        name: "job-with-template",
        directory: "/tmp",
        prompt: "test",
      });
      const job = JSON.parse(parseToolText(createJobRes.body));
      expect(job.templateId).toBeTruthy();

      // Try to delete the backing template
      const deleteRes = await mcpToolCall(agentId, "delete_template", {
        templateId: job.templateId,
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.body).toContain("referenced by one or more jobs");
    });

    it("defaults directory to agent cwd when omitted", async () => {
      const createRes = await mcpToolCall(agentId, "create_template", {
        name: "cwd-default-template",
        prompt: "test",
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(parseToolText(createRes.body));
      expect(created.directory).toBe("/tmp");
    });
  });
});
