import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Actual HTTP sockets, real auth middleware, MCP JSON-RPC, service and isolated
// migrated Postgres. No production listener or agent runtime is used.
const ctx = useInjectApp();
let base: string;
beforeAll(async () => {
  base = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
});

it("enforces board watch identity and project contracts over real agent/job/admin MCP transports", async () => {
  const project = "prj_board_transport";
  await ctx.pool.query(
    `INSERT INTO projects (id, name, repo_root, color) VALUES ($1, 'Transport', '/tmp/board-transport', '#336699')`,
    [project]
  );
  for (const [id, projectId] of [
    ["agt_board_transport", project],
    ["agt_board_job", project],
    ["agt_board_no_project", null],
  ]) {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, project_id) VALUES ($1, $1, 'codex', 'stopped', '/tmp', $2)`,
      [id, projectId]
    );
  }
  await ctx.pool
    .query(`INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
    VALUES ('job_board', '/tmp', 'Board', true, 'codex', false, false, null, 1800000, 1800000, true)`);
  await ctx.pool
    .query(`INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
    VALUES ('run_board', 'job_board', 'running', now(), now(), 'agt_board_job')`);
  const token = (
    await ctx.pool.query(`SELECT value FROM settings WHERE key = 'auth_token'`)
  ).rows[0].value;
  const agentToken = (id: string) => ctx.auth.createAgentMcpToken(token, id);
  const jobToken = ctx.auth.createJobMcpToken(
    token,
    "run_board",
    "agt_board_job"
  );
  // Stopped synthetic agents keep inbox inspection deterministic; delivery and
  // acceptance are exercised by the stream integration suite, not this harness.
  const evidence: Array<Record<string, unknown>> = [];
  let requestId = 0;
  const rpc = async (
    route: string,
    bearer: string,
    method: string,
    params: object
  ) => {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    const body = JSON.parse(data ? data.slice(6) : text);
    const state = body.result?.structuredContent;
    evidence.push({
      surface: route.includes("/jobs/")
        ? "job"
        : route === "/api/mcp"
          ? "public/admin"
          : "agent",
      method:
        method === "tools/call" ? (params as { name: string }).name : method,
      status: response.status,
      error: Boolean(
        body.error || body.result?.isError || response.status >= 400
      ),
      ...(state?.projectId ? { projectId: state.projectId } : {}),
      ...(typeof state?.watching === "boolean"
        ? { watching: state.watching }
        : {}),
      ...(typeof state?.boardWatching === "boolean"
        ? { boardWatching: state.boardWatching }
        : {}),
    });
    return { status: response.status, body };
  };
  for (const [route, bearer] of [
    ["/api/mcp/agt_board_transport", agentToken("agt_board_transport")],
    ["/api/mcp/jobs/run_board/agt_board_job", jobToken],
  ]) {
    const inventory = await rpc(route, bearer, "tools/list", {});
    expect(inventory.status).toBe(200);
    expect(
      inventory.body.result.tools.map((t: { name: string }) => t.name)
    ).toContain("task_board_watch");
    const call = (name: string, args: object = {}) =>
      rpc(route, bearer, "tools/call", { name, arguments: args });
    expect(
      (await call("task_board_watch")).body.result.structuredContent
    ).toEqual({ projectId: project, watching: true });
    expect(
      (await call("task_board_watch", { projectId: project })).body.result
        .structuredContent.watching
    ).toBe(true);
    expect(
      (await call("task_list")).body.result.structuredContent.boardWatching
    ).toBe(true);
    expect(
      (await call("task_board_watch", { projectId: "foreign" })).body.result
        .isError
    ).toBe(true);
    expect(
      (await call("task_board_watch", { projectId: "" })).body.result.isError
    ).toBe(true);
    const subscriber = route.includes("/jobs/")
      ? "agt_board_job"
      : "agt_board_transport";
    const creatorRoute =
      subscriber === "agt_board_job"
        ? "/api/mcp/agt_board_transport"
        : "/api/mcp/jobs/run_board/agt_board_job";
    const creatorToken =
      subscriber === "agt_board_job"
        ? agentToken("agt_board_transport")
        : jobToken;
    const create = async (name: string, args: object) => {
      const result = await rpc(creatorRoute, creatorToken, "tools/call", {
        name,
        arguments: args,
      });
      expect(result.body.result.isError).not.toBe(true);
      return result.body.result.structuredContent;
    };
    const task = await create("task_create", {
      title: "Created after board watch",
    });
    await create("task_comment", {
      id: task.id,
      text: "Conversation after board watch",
    });
    expect(
      (
        await ctx.pool.query(`SELECT * FROM task_watches WHERE task_id = $1`, [
          task.id,
        ])
      ).rows
    ).toHaveLength(0);
    const pending = (
      await ctx.pool.query(
        `SELECT i.source, i.item_id, i.board_watch_id FROM task_watch_items i
      WHERE i.task_id = $1 AND i.agent_id = $2`,
        [task.id, subscriber]
      )
    ).rows;
    expect(pending.filter((i) => i.source === "event")).toHaveLength(1);
    expect(pending.filter((i) => i.source === "block")).toHaveLength(1);
    expect(pending.every((i) => i.board_watch_id !== null)).toBe(true);
    await call("task_watch", { id: task.id });
    await create("task_comment", { id: task.id, text: "Overlapping coverage" });
    const counts = (
      await ctx.pool.query(
        `SELECT count(*)::int AS coverage_rows,
      count(DISTINCT (source, item_id))::int AS source_items
      FROM task_watch_items WHERE task_id = $1 AND agent_id = $2`,
        [task.id, subscriber]
      )
    ).rows[0];
    expect(counts).toEqual({ coverage_rows: 4, source_items: 3 });
    await call("task_unwatch", { id: task.id });
    expect(
      (await call("task_list")).body.result.structuredContent.boardWatching
    ).toBe(true);
    evidence.push({
      surface: subscriber === "agt_board_job" ? "job" : "agent",
      method: "durable-inbox-proof",
      projectId: project,
      explicitWatchesBeforeOverlap: 0,
      createdEvents: 1,
      conversationPosts: 1,
      overlapCoverageRows: counts.coverage_rows,
      overlapDistinctSources: counts.source_items,
      runtimeDelivery: "covered separately in stream integration tests",
    });
    expect(
      (await call("task_board_unwatch")).body.result.structuredContent
    ).toEqual({ projectId: project, watching: false });
    expect(
      (await call("task_list")).body.result.structuredContent.boardWatching
    ).toBe(false);
  }
  const publicCall = await rpc("/api/mcp", token, "tools/call", {
    name: "task_board_watch",
    arguments: {},
  });
  expect(publicCall.status).toBe(200);
  expect(publicCall.body.error ?? publicCall.body.result?.isError).toBeTruthy();
  expect(
    (
      await rpc(
        "/api/mcp/agt_board_transport",
        agentToken("agt_board_job"),
        "tools/list",
        {}
      )
    ).status
  ).toBe(403);
  expect(
    (
      await rpc(
        "/api/mcp/agt_unknown_board",
        agentToken("agt_unknown_board"),
        "tools/list",
        {}
      )
    ).status
  ).toBe(404);
  const noProject = await rpc(
    "/api/mcp/agt_board_no_project",
    agentToken("agt_board_no_project"),
    "tools/call",
    { name: "task_board_watch", arguments: {} }
  );
  expect(noProject.body.result.isError).toBe(true);
  expect(
    (await ctx.pool.query(`SELECT * FROM task_board_watches`)).rows
  ).toHaveLength(0);
  const evidencePath =
    process.env.DISPATCH_BOARD_EVIDENCE_PATH ??
    path.join(tmpdir(), `dispatch-board-watch-proof-${process.pid}.json`);
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        result: "passed",
        transport: "real HTTP MCP + isolated Postgres",
        evidence,
      },
      null,
      2
    )
  );
  console.info(`Safe board-watch transport evidence: ${evidencePath}`);
});
