import { beforeAll, expect, it, vi } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

vi.mock(
  "../../../packages/runner/src/workload/shared/lib/run-command.js",
  () => import("../src/shared/lib/run-command.js")
);
vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Real HTTP socket, agent MCP auth, JSON-RPC, service and migrated Postgres;
// the board/detail HTTP routes read what the tools wrote.
const ctx = useInjectApp();
let base: string;
beforeAll(async () => {
  base = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
});

it("manages goals over the agent MCP transport and the board/detail routes agree", async () => {
  const project = "prj_goal_transport";
  await ctx.pool.query(
    `INSERT INTO projects (id, name, repo_root, color) VALUES ($1, 'Goals', '/tmp/goal-transport', '#336699')`,
    [project]
  );
  await ctx.pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, project_id) VALUES ('agt_goal_transport', 'g', 'codex', 'stopped', '/tmp', $1)`,
    [project]
  );
  const token = (
    await ctx.pool.query(`SELECT value FROM settings WHERE key = 'auth_token'`)
  ).rows[0].value;
  const bearer = ctx.auth.createAgentMcpToken(token, "agt_goal_transport");
  let requestId = 0;
  const call = async (name: string, args: object) => {
    const response = await fetch(`${base}/api/mcp/agt_goal_transport`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text).result;
  };
  const created = await call("task_create", {
    title: "Goal transport",
    goals: ["Persist", "Render"],
  });
  expect(created.isError).not.toBe(true);
  const id = created.structuredContent.id;
  const [persist] = created.structuredContent.goals;
  const done = await call("task_goal_update", {
    id,
    changes: [{ goalId: persist.id, action: "complete" }],
    requestId: "complete-persist",
  });
  expect(done.structuredContent.goalCounts).toEqual({ completed: 1, total: 2 });
  const retry = await call("task_goal_update", {
    id,
    changes: [{ goalId: persist.id, action: "complete" }],
    requestId: "complete-persist",
  });
  expect(retry.structuredContent.replayed).toBe(true);
  const invalid = await call("task_goal_update", {
    id,
    changes: [{ goalId: persist.id, action: "finish" }],
  });
  expect(invalid.isError).toBe(true);

  const cookie = await ctx.sessionCookie();
  const board = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/projects/${project}/tasks/board`,
    headers: { cookie },
  });
  expect(board.statusCode).toBe(200);
  const row = board.json().tasks.find((t: { id: string }) => t.id === id);
  expect(row.goalCounts).toEqual({ completed: 1, total: 2 });
  expect(row.goals).toBeUndefined();
  const detail = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/tasks/${id}`,
    headers: { cookie },
  });
  expect(detail.json().goalCounts).toEqual(row.goalCounts);
  expect(
    detail
      .json()
      .goals.map((g: { title: string; state: string }) => [g.title, g.state])
  ).toEqual([
    ["Persist", "completed"],
    ["Render", "open"],
  ]);
  const goalEvents = detail
    .json()
    .events.filter((e: { kind: string }) => e.kind === "goals_changed");
  expect(goalEvents).toHaveLength(2);
  expect(goalEvents[1].actor).toEqual({
    kind: "agent",
    agentId: "agt_goal_transport",
  });
});
