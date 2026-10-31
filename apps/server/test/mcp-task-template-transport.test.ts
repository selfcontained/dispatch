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

it("round-trips stage overrides, previews and clear across authenticated MCP and HTTP", async () => {
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
  const operation = { columnId: stage.id, templateId: lead.id };
  const created = await call("task_create", {
    title: "Lead task",
    launchTemplate: operation,
  });
  expect(created.isError).toBeUndefined();
  const id = created.structuredContent.id;
  expect(created.structuredContent.launchTemplates).toEqual({
    [stage.id]: lead.id,
  });
  expect(created.structuredContent.launchPreviews[stage.id]).toMatchObject({
    source: "task",
    configuration: { agentType: "codex", model: "gpt-5.5" },
  });
  const read = await call("task_get", {
    id,
    launchTemplate: { columnId: stage.id, templateId: null },
  });
  expect(read.structuredContent.launchPreview).toMatchObject({
    source: "column",
    configuration: { agentType: "claude", model: "haiku" },
  });
  expect((await http("GET", `/api/v1/tasks/${id}`)).launchTemplates).toEqual({
    [stage.id]: lead.id,
  });
  const denied = await call("task_update", {
    id,
    title: "Must remain unchanged",
    launchTemplate: { columnId: stage.id, templateId: full.id },
  });
  expect(denied.isError).toBe(true);
  expect((await http("GET", `/api/v1/tasks/${id}`)).title).toBe("Lead task");
  const malformed = await call("task_update", {
    id,
    launchTemplate: { columnId: stage.id },
  });
  expect(malformed.isError).toBe(true);
  const priorRevision =
    read.structuredContent.launchPreviews[stage.id].revision;
  await http("PATCH", `/api/v1/templates/${lead.id}`, { model: "gpt-5.6-sol" });
  const beforeRefusal = await http("GET", `/api/v1/tasks/${id}`);
  const refused = await call("task_update", {
    id,
    column: "in_progress",
    title: "Wrong",
    expectedLaunchRevision: priorRevision,
  });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error.code).toBe("launch_preview_changed");
  expect(await http("GET", `/api/v1/tasks/${id}`)).toEqual(beforeRefusal);
  const changedRevision = beforeRefusal.launchPreviews[stage.id].revision;
  await http("PATCH", `/api/v1/templates/${lead.id}`, { model: "gpt-5.5" });
  const refusedHttp = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/tasks/${id}`,
    headers,
    payload: { columnId: stage.id, expectedLaunchRevision: changedRevision },
  });
  expect(refusedHttp.statusCode).toBe(409);
  expect(refusedHttp.json().code).toBe("launch_preview_changed");
  const invalidRevision = await call("task_update", {
    id,
    column: "in_progress",
    expectedLaunchRevision: "not-a-server-revision",
  });
  expect(invalidRevision.isError).toBe(true);
  const latest = await http("GET", `/api/v1/tasks/${id}`);
  const moved = await call("task_update", {
    id,
    column: "in_progress",
    expectedLaunchRevision: latest.launchPreviews[stage.id].revision,
  });
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
  const cleared = await call("task_update", {
    id,
    launchTemplate: { columnId: stage.id, templateId: null },
  });
  expect(cleared.structuredContent.launchTemplates).toEqual({});
  expect(cleared.structuredContent.launchPreviews[review.id]).toMatchObject({
    source: "column",
    templateId: builder.id,
  });
  const events = (await http("GET", `/api/v1/tasks/${id}`)).events;
  expect(
    events.filter((e: { kind: string }) => e.kind === "trigger_launched")
  ).toHaveLength(1);
  // Persisted preference survives deletion as an explicit unavailable choice.
  await http("PATCH", `/api/v1/tasks/${id}`, { launchTemplate: operation });
  await http("DELETE", `/api/v1/templates/${lead.id}`);
  const missing = await call("task_get", { id });
  expect(missing.structuredContent.launchPreviews[stage.id]).toMatchObject({
    source: "task",
    available: false,
  });
});
