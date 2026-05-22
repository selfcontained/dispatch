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
let authToken: string;

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

  const tokenResult = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'auth_token'"
  );
  authToken = tokenResult.rows[0]!.value;
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
  await pool.query("DELETE FROM job_runs");
  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM templates");
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agent_feedback");
  await pool.query("DELETE FROM persona_reviews");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM sessions");
  const session = await createSession(pool);
  const signed = (
    app as FastifyInstance & { signCookie: (value: string) => string }
  ).signCookie(session);
  sessionCookie = `dispatch_session=${signed}`;
});

async function mcpToolsList(url: string, token: string) {
  return app.inject({
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
  return app.inject({
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
  return app.inject({
    method: "POST",
    url: `/api/mcp/jobs/${runId}/${agentId}`,
    headers: {
      authorization: `Bearer ${createJobMcpToken(authToken, runId, agentId)}`,
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
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ('agt_crud_agent', 'crud-agent', 'claude', 'running', '/tmp', false)`
      );

      const response = await mcpToolsList(
        "/api/mcp/agt_crud_agent",
        createAgentMcpToken(authToken, "agt_crud_agent")
      );

      expect(response.statusCode).toBe(200);
      for (const tool of CRUD_TOOL_NAMES) {
        expect(response.body).toContain(tool);
      }
    });

    it("exposes CRUD tools for job agents", async () => {
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ('agt_crud_job', 'crud-job', 'claude', 'running', '/tmp', false)`
      );
      await pool.query(
        `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
         VALUES ('job_crud', '/tmp', 'CRUD Job', false, 'claude', false, false, null, 1800000, 1800000, true)`
      );
      await pool.query(
        `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
         VALUES ('run_crud', 'job_crud', 'running', NOW(), NOW(), 'agt_crud_job')`
      );

      const response = await mcpToolsList(
        "/api/mcp/jobs/run_crud/agt_crud_job",
        createJobMcpToken(authToken, "run_crud", "agt_crud_job")
      );

      expect(response.statusCode).toBe(200);
      for (const tool of CRUD_TOOL_NAMES) {
        expect(response.body).toContain(tool);
      }
    });

    it("does NOT expose CRUD tools for persona agents", async () => {
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, persona, parent_agent_id, full_access)
         VALUES
         ('agt_crud_parent', 'parent', 'claude', 'running', '/tmp', null, null, false),
         ('agt_crud_persona', 'persona', 'claude', 'running', '/tmp', 'security-review', 'agt_crud_parent', false)`
      );
      await pool.query(
        `INSERT INTO persona_reviews (agent_id, parent_agent_id, persona, status, round_number, allow_recheck)
         VALUES ('agt_crud_persona', 'agt_crud_parent', 'security-review', 'reviewing', 1, false)`
      );

      const response = await mcpToolsList(
        "/api/mcp/agt_crud_persona",
        createAgentMcpToken(authToken, "agt_crud_persona")
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
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, full_access)
         VALUES ($1, 'jobscope-crud', 'claude', 'running', '/tmp', false)`,
        [agentId]
      );
      await pool.query(
        `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
         VALUES ('job_scope', '/tmp', 'Scope Job', false, 'claude', false, false, null, 1800000, 1800000, true)`
      );
      await pool.query(
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
      const res = await app.inject({
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
      await pool.query(
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
      await pool.query(
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
