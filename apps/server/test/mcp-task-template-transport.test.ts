import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Real sockets, signed caller identity, HTTP/MCP schemas, services, migrated DB;
// agent runtime is inert, so this does not spend provider usage.
const ctx = useInjectApp();
let base: string;
beforeAll(async () => {
  base = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
});

it("round-trips task overrides and clear across authenticated MCP and HTTP", async () => {
  const projectId = "prj_template_transport";
  await ctx.pool.query(
    `INSERT INTO projects (id, name, repo_root, color) VALUES ($1, 'Templates', '/tmp', '#336699')`,
    [projectId]
  );
  await ctx.pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, project_id) VALUES ('agt_template_caller', 'Caller', 'codex', 'stopped', '/tmp', $1)`,
    [projectId]
  );
  const token = (
    await ctx.pool.query(`SELECT value FROM settings WHERE key = 'auth_token'`)
  ).rows[0].value;
  const headers = { authorization: `Bearer ${token}` };
  const http = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object
  ) => {
    const response = await ctx.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode, response.body).toBeLessThan(400);
    return response.json();
  };
  const board = await http("GET", `/api/v1/projects/${projectId}/tasks/board`);
  const stage = board.columns.find(
    (c: { key: string }) => c.key === "in_progress"
  );
  const review = board.columns.find(
    (c: { key: string }) => c.key === "in_review"
  );
  const makeTemplate = (name: string, fullAccess = false) =>
    http("POST", "/api/v1/templates", {
      name,
      projectId,
      directory: "/tmp",
      agentType: "codex",
      model: "gpt-5.5",
      prompt: "Work on this task",
      fullAccess,
    });
  const builder = await makeTemplate("Builder");
  const lead = await makeTemplate("Lead");
  const full = await makeTemplate("Full access", true);
  for (const column of [stage, review])
    await http("PATCH", `/api/v1/task-columns/${column.id}`, {
      trigger: {
        templateId: builder.id,
        agentType: "claude",
        model: "haiku",
        assign: false,
      },
    });
  const agentBearer = ctx.auth.createAgentMcpToken(
    token,
    "agt_template_caller"
  );
  let seq = 0;
  const call = async (name: string, args: object) => {
    const response = await fetch(`${base}/api/mcp/agt_template_caller`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentBearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++seq,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text).result;
  };
  const launchTemplateId = lead.id;
  const created = await call("task_create", {
    title: "Lead task",
    launchTemplateId,
  });
  expect(created.isError).toBeUndefined();
  const id = created.structuredContent.id;
  expect(created.structuredContent.launchTemplateId).toBe(lead.id);
  expect((await http("GET", `/api/v1/tasks/${id}`)).launchTemplateId).toBe(
    lead.id
  );
  const denied = await call("task_update", {
    id,
    title: "Must remain unchanged",
    launchTemplateId: full.id,
  });
  expect(denied.isError).toBe(true);
  expect((await http("GET", `/api/v1/tasks/${id}`)).title).toBe("Lead task");
  const malformed = await call("task_update", {
    id,
    launchTemplateId: {},
  });
  expect(malformed.isError).toBe(true);
  const moved = await call("task_update", { id, column: "in_progress" });
  expect(moved.isError).toBeUndefined();
  const launched = (await http("GET", `/api/v1/tasks/${id}`)).events.find(
    (e: { kind: string }) => e.kind === "trigger_launched"
  );
  expect(launched).toMatchObject({
    data: {
      templateId: lead.id,
      source: "task",
      configuration: { agentType: "codex", model: "gpt-5.5" },
    },
  });
  await ctx.awaitLaunched(launched.data.agentId);
  // A normal signed agent move needs no preview, revision or human gate.
  const directTask = await call("task_create", {
    title: "Direct agent stage move",
    launchTemplateId,
  });
  expect(directTask.isError).toBeUndefined();
  const directId = directTask.structuredContent.id;
  const directMove = await call("task_update", {
    id: directId,
    column: "in_progress",
  });
  expect(directMove.isError).toBeUndefined();
  const directDetail = await http("GET", `/api/v1/tasks/${directId}`);
  expect(directDetail.columnId).toBe(stage.id);
  const directLaunches = directDetail.events.filter(
    (e: { kind: string }) => e.kind === "trigger_launched"
  );
  expect(directLaunches).toHaveLength(1);
  expect(directLaunches[0].data).toMatchObject({
    columnId: stage.id,
    source: "task",
    templateId: lead.id,
    configuration: {
      agentType: "codex",
      model: "gpt-5.5",
      directory: "/tmp",
      fullAccess: false,
      prompt: "Work on this task",
    },
  });
  await ctx.awaitLaunched(directLaunches[0].data.agentId);
  // A repeated update to the same stage must not launch a second agent.
  expect(
    (await call("task_update", { id: directId, column: "in_progress" })).isError
  ).toBeUndefined();
  expect(
    (await http("GET", `/api/v1/tasks/${directId}`)).events.filter(
      (e: { kind: string }) => e.kind === "trigger_launched"
    )
  ).toHaveLength(1);
  const cleared = await call("task_update", {
    id,
    launchTemplateId: null,
  });
  expect(cleared.structuredContent.launchTemplateId).toBeNull();
  const events = (await http("GET", `/api/v1/tasks/${id}`)).events;
  expect(
    events.filter((e: { kind: string }) => e.kind === "trigger_launched")
  ).toHaveLength(1);
  // Persisted preference survives deletion as an explicit unavailable choice.
  await http("PATCH", `/api/v1/tasks/${id}`, { launchTemplateId });
  await http("DELETE", `/api/v1/templates/${lead.id}`);
  const missing = await call("task_get", { id });
  expect(missing.structuredContent.launchTemplateId).toBe(lead.id);
});

it("applies per-task runtime/model overrides over MCP without editing the column or template", async () => {
  const projectId = "prj_runtime_transport";
  const repo = await mkdtemp(path.join(tmpdir(), "task-runtime-"));
  await ctx.pool.query(
    `INSERT INTO projects (id, name, repo_root, color) VALUES ($1, 'Runtime', $2, '#336699')`,
    [projectId, repo]
  );
  await ctx.pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, project_id) VALUES ('agt_runtime_caller', 'Caller', 'codex', 'stopped', $2, $1)`,
    [projectId, repo]
  );
  const token = (
    await ctx.pool.query(`SELECT value FROM settings WHERE key = 'auth_token'`)
  ).rows[0].value;
  const http = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object
  ) => {
    const response = await ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json() };
  };
  const board = (await http("GET", `/api/v1/projects/${projectId}/tasks/board`))
    .body;
  const stage = board.columns.find(
    (c: { key: string }) => c.key === "in_progress"
  );
  const template = (
    await http("POST", "/api/v1/templates", {
      name: "Build Task",
      projectId,
      directory: repo,
      agentType: "codex",
      model: "gpt-5.5",
      prompt: "Work on this task",
    })
  ).body;
  await http("PATCH", `/api/v1/task-columns/${stage.id}`, {
    trigger: { templateId: template.id, assign: false },
  });
  const columnBefore = (
    await http("GET", `/api/v1/projects/${projectId}/tasks/board`)
  ).body.columns.find((c: { id: string }) => c.id === stage.id).trigger;
  const bearer = ctx.auth.createAgentMcpToken(token, "agt_runtime_caller");
  let seq = 0;
  const call = async (name: string, args: object) => {
    const response = await fetch(`${base}/api/mcp/agt_runtime_caller`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++seq,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text).result;
  };

  const created = await call("task_create", {
    title: "Run this one on Claude",
    launchAgentType: "claude",
    launchModel: "sonnet",
  });
  expect(created.isError).toBeUndefined();
  expect(created.structuredContent).toMatchObject({
    launchAgentType: "claude",
    launchModel: "sonnet",
  });
  const id = created.structuredContent.id;

  const invalid = await call("task_update", {
    id,
    title: "Must remain",
    column: "in_progress",
    launchAgentType: "codex",
  });
  expect(invalid.isError).toBe(true);
  expect(invalid.content[0].text).toMatch(/not supported for codex/);
  let detail = (await http("GET", `/api/v1/tasks/${id}`)).body;
  expect(detail).toMatchObject({
    title: "Run this one on Claude",
    launchAgentType: "claude",
    launchModel: "sonnet",
  });
  expect(detail.columnId).not.toBe(stage.id);

  expect(
    (await call("task_update", { id, column: "in_progress" })).isError
  ).toBeUndefined();
  detail = (await http("GET", `/api/v1/tasks/${id}`)).body;
  const launched = detail.events.find(
    (e: { kind: string }) => e.kind === "trigger_launched"
  );
  expect(launched.data).toMatchObject({
    templateId: template.id,
    runtimeOverride: { agentType: "claude", model: "sonnet" },
    configuration: { agentType: "claude", model: "sonnet" },
  });
  await ctx.awaitLaunched(launched.data.agentId);
  expect(
    (await http("GET", `/api/v1/templates/${template.id}`)).body
  ).toMatchObject({ agentType: "codex", model: "gpt-5.5" });
  expect(
    (
      await http("GET", `/api/v1/projects/${projectId}/tasks/board`)
    ).body.columns.find((c: { id: string }) => c.id === stage.id).trigger
  ).toEqual(columnBefore);

  const cleared = await call("task_update", { id, launchAgentType: null });
  expect(cleared.structuredContent).toMatchObject({
    launchAgentType: null,
    launchModel: null,
  });
  const runtimeOnly = await call("task_update", {
    id,
    launchAgentType: "claude",
  });
  expect(runtimeOnly.isError).toBe(true);
  expect(runtimeOnly.content[0].text).toMatch(/needs an explicit launchModel/);
  const clearModel = await http("PATCH", `/api/v1/tasks/${id}`, {
    launchAgentType: "claude",
    launchModel: null,
  });
  expect(clearModel.status).toBe(400);
  const rejected = await http("PATCH", `/api/v1/tasks/${id}`, {
    launchModel: "sonnet",
  });
  expect(rejected.status).toBe(400);
  expect(
    (
      await http("PATCH", `/api/v1/tasks/${id}`, {
        launchAgentType: "codex",
        launchModel: "gpt-5.5",
      })
    ).body
  ).toMatchObject({ launchAgentType: "codex", launchModel: "gpt-5.5" });
});
