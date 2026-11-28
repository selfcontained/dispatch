import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerTaskTools } from "../src/shared/mcp/task-tools.js";
import { readRepositoryRoot } from "./helpers/task-scope.js";
import { TaskService } from "../src/tasks/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let service: TaskService;
let projectId: string;
let otherProjectId: string;
let published: Array<{ type: string; projectId: string; taskId?: string }>;

const AGENT = { kind: "agent", agentId: "agt_goals" } as const;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM task_columns");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM projects");
  projectId = (
    await pool.query(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Goals', '/repo/goals', '#336699') RETURNING id`
    )
  ).rows[0].id;
  otherProjectId = (
    await pool.query(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Other', '/repo/other', '#336699') RETURNING id`
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_goals', 'Goals', '/tmp', 'running')`
  );
  published = [];
  service = new TaskService({
    readRepositoryRoot,
    pool,
    filesRoot: "/tmp/task-goals-unused",
    getAgent: async () => null,
    getTemplate: async () => null,
    launchTemplate: async () => {
      throw new Error("no launches in goal tests");
    },
    chat: {} as never,
    publishUiEvent: (event) => published.push(event),
    log: { warn: vi.fn(), info: vi.fn() },
  } as ConstructorParameters<typeof TaskService>[0]);
});

async function newTask(goals?: string[], project = projectId) {
  return service.createTask(
    { projectId: project, title: "Goal task", ...(goals ? { goals } : {}) },
    AGENT
  );
}

async function goalEvents(taskId: string) {
  const { rows } = await pool.query(
    `SELECT actor_kind, actor_agent_id, data FROM task_events
     WHERE task_id = $1 AND kind = 'goals_changed' ORDER BY created_at`,
    [taskId]
  );
  return rows;
}

async function boardCounts(taskId: string) {
  const board = await service.getBoard(projectId);
  return board.tasks.find((task) => task.id === taskId)?.goalCounts;
}

describe("task goals service", () => {
  it("starts legacy and new tasks with no goals", async () => {
    const task = await newTask();
    expect(task.goalCounts).toEqual({ completed: 0, total: 0 });
    const detail = await service.getTaskDetail(task.id);
    expect(detail.goals).toEqual([]);
    expect(await goalEvents(task.id)).toEqual([]);
  });

  it("creates initial goals in order, recorded with the actor", async () => {
    const task = await newTask(["  Persist goals ", "Show progress"]);
    const detail = await service.getTaskDetail(task.id);
    expect(
      detail.goals.map(({ title, state, position }) => ({
        title,
        state,
        position,
      }))
    ).toEqual([
      { title: "Persist goals", state: "open", position: 0 },
      { title: "Show progress", state: "open", position: 1 },
    ]);
    expect(detail.goalCounts).toEqual({ completed: 0, total: 2 });
    const events = await goalEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_kind: "agent",
      actor_agent_id: "agt_goals",
    });
    expect(events[0].data.changes.map((c: { op: string }) => c.op)).toEqual([
      "added",
      "added",
    ]);
  });

  it("rejects a blank initial goal before creating anything", async () => {
    await expect(newTask(["ok", "   "])).rejects.toMatchObject({
      status: 400,
    });
    expect((await pool.query("SELECT count(*) FROM tasks")).rows[0].count).toBe(
      "0"
    );
  });

  it("walks the acceptance lifecycle with board and detail agreeing", async () => {
    const task = await newTask(["One", "Two"]);
    const [one, two] = (await service.getTaskDetail(task.id)).goals;
    const column = task.columnId;
    const agree = async (expected: { completed: number; total: number }) => {
      expect(await boardCounts(task.id)).toEqual(expected);
      expect((await service.getTaskDetail(task.id)).goalCounts).toEqual(
        expected
      );
      expect((await service.listTasks({ projectId }))[0]!.goalCounts).toEqual(
        expected
      );
    };
    await service.editGoals(
      task.id,
      [{ goalId: one!.id, action: "complete" }],
      AGENT
    );
    await agree({ completed: 1, total: 2 });
    const added = await service.addGoals(task.id, ["Three"], AGENT);
    const three = added.goals[2]!;
    expect(three.position).toBe(2);
    await agree({ completed: 1, total: 3 });
    await service.editGoals(
      task.id,
      [
        { goalId: two!.id, action: "complete" },
        { goalId: three.id, action: "complete" },
      ],
      AGENT
    );
    await agree({ completed: 3, total: 3 });
    // Completing every goal never moves or completes the task.
    const after = await service.requireTask(task.id);
    expect(after.columnId).toBe(column);
    expect(after.completedAt).toBeNull();
    await service.editGoals(
      task.id,
      [{ goalId: three.id, action: "reopen" }],
      AGENT
    );
    await agree({ completed: 2, total: 3 });
    await service.editGoals(
      task.id,
      [{ goalId: three.id, title: "Three, renamed" }],
      AGENT
    );
    const retired = await service.editGoals(
      task.id,
      [{ goalId: three.id, action: "retire" }],
      AGENT
    );
    expect(retired.goals[2]).toMatchObject({
      title: "Three, renamed",
      state: "retired",
    });
    await agree({ completed: 2, total: 2 });
    const ops = (await goalEvents(task.id)).flatMap((e) =>
      e.data.changes.map((c: { op: string }) => c.op)
    );
    expect(ops).toEqual([
      "added",
      "added",
      "completed",
      "added",
      "completed",
      "completed",
      "reopened",
      "renamed",
      "retired",
    ]);
    expect(
      published.filter((e) => e.taskId === task.id).length
    ).toBeGreaterThan(5);
  });

  it("hides progress when every goal is retired", async () => {
    const task = await newTask(["Only"]);
    const [only] = (await service.getTaskDetail(task.id)).goals;
    await service.editGoals(
      task.id,
      [{ goalId: only!.id, action: "retire" }],
      AGENT
    );
    expect(await boardCounts(task.id)).toEqual({ completed: 0, total: 0 });
    expect((await service.getTaskDetail(task.id)).goals).toHaveLength(1);
  });

  it("rejects invalid, foreign and wrong-task goal IDs without writing anything", async () => {
    const task = await newTask(["A", "B"]);
    const other = await newTask(["Elsewhere"]);
    const [a] = (await service.getTaskDetail(task.id)).goals;
    const [foreign] = (await service.getTaskDetail(other.id)).goals;
    const before = await goalEvents(task.id);
    for (const edits of [
      [{ goalId: "tgl_missing", action: "complete" as const }],
      [
        { goalId: a!.id, action: "complete" as const },
        { goalId: foreign!.id, action: "complete" as const },
      ],
      [
        { goalId: a!.id, action: "complete" as const },
        { goalId: a!.id, title: "dup" },
      ],
      [{ goalId: a!.id, title: "   " }],
      [{ goalId: a!.id, title: "B" }],
      [{ goalId: a!.id }],
    ]) {
      await expect(
        service.editGoals(task.id, edits, AGENT)
      ).rejects.toMatchObject({
        status: 400,
      });
    }
    // Failed batches are all-or-nothing.
    expect(
      (await service.getTaskDetail(task.id)).goals.map((g) => g.state)
    ).toEqual(["open", "open"]);
    expect(await goalEvents(task.id)).toEqual(before);
    await expect(
      service.editGoals(
        "tsk_missing",
        [{ goalId: a!.id, action: "complete" }],
        AGENT
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to complete a retired goal until it is reopened", async () => {
    const task = await newTask(["A"]);
    const [a] = (await service.getTaskDetail(task.id)).goals;
    await service.editGoals(
      task.id,
      [{ goalId: a!.id, action: "retire" }],
      AGENT
    );
    await expect(
      service.editGoals(task.id, [{ goalId: a!.id, action: "complete" }], AGENT)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("makes retries harmless: no-op edits, skipped duplicate adds, replayed requestIds", async () => {
    const task = await newTask(["A"]);
    const [a] = (await service.getTaskDetail(task.id)).goals;
    await service.editGoals(
      task.id,
      [{ goalId: a!.id, action: "complete" }],
      AGENT
    );
    const again = await service.editGoals(
      task.id,
      [{ goalId: a!.id, action: "complete" }],
      AGENT
    );
    expect(again.changes).toEqual([]);
    const dup = await service.addGoals(task.id, ["a", "New", "new"], AGENT);
    expect(dup.changes.map((c) => c.title)).toEqual(["New"]);
    const first = await service.addGoals(task.id, ["Retried"], AGENT, {
      requestId: "req-1",
    });
    // Retire it, then replay: the replay must not re-add it.
    await service.editGoals(
      task.id,
      [{ goalId: first.changes[0]!.goalId, action: "retire" }],
      AGENT
    );
    const replay = await service.addGoals(task.id, ["Retried"], AGENT, {
      requestId: "req-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.changes).toEqual(first.changes);
    await expect(
      service.addGoals(task.id, ["Different"], AGENT, { requestId: "req-1" })
    ).rejects.toMatchObject({ status: 409, code: "request_id_reused" });
    const detail = await service.getTaskDetail(task.id);
    expect(detail.goals.map((g) => g.title)).toEqual(["A", "New", "Retried"]);
    const ops = (await goalEvents(task.id)).flatMap((e) => e.data.changes);
    expect(
      ops.filter((c: { title: string }) => c.title === "Retried")
    ).toHaveLength(2);
  });

  it("replays against current goals, canonicalizes payloads and expires old requests", async () => {
    const task = await newTask(["A", "B"]);
    const [a, b] = (await service.getTaskDetail(task.id)).goals;
    const first = await service.editGoals(
      task.id,
      [{ goalId: a!.id, action: "complete", title: "A1" }],
      AGENT,
      { requestId: "edit-1" }
    );
    await service.editGoals(
      task.id,
      [{ goalId: b!.id, action: "complete" }],
      AGENT
    );
    // Same edit, keys in another order: a replay, not a 409.
    const replay = await service.editGoals(
      task.id,
      [{ title: "A1", action: "complete", goalId: a!.id }],
      AGENT,
      { requestId: "edit-1" }
    );
    expect(replay.replayed).toBe(true);
    expect(replay.changes).toEqual(first.changes);
    expect(replay.goalCounts).toEqual({ completed: 2, total: 2 });
    expect(replay.goals.map((g) => g.state)).toEqual([
      "completed",
      "completed",
    ]);
    await pool.query(
      `UPDATE task_goal_requests SET created_at = now() - interval '8 days' WHERE task_id = $1`,
      [task.id]
    );
    await service.addGoals(task.id, ["C"], AGENT, { requestId: "add-1" });
    const { rows } = await pool.query(
      `SELECT request_id FROM task_goal_requests WHERE task_id = $1`,
      [task.id]
    );
    expect(rows.map((r) => r.request_id)).toEqual(["add-1"]);
  });

  it("publishes a created task's goals once, with the creation", async () => {
    const task = await newTask(["A", "B"]);
    expect(published.filter((e) => e.taskId === task.id)).toHaveLength(1);
  });

  it("keeps independent concurrent edits and same-request retries exact", async () => {
    const task = await newTask(["A", "B", "C"]);
    const [a, b, c] = (await service.getTaskDetail(task.id)).goals;
    await Promise.all([
      service.editGoals(
        task.id,
        [{ goalId: a!.id, action: "complete" }],
        AGENT
      ),
      service.editGoals(
        task.id,
        [{ goalId: b!.id, title: "B renamed" }],
        AGENT
      ),
      service.editGoals(task.id, [{ goalId: c!.id, action: "retire" }], AGENT),
      service.addGoals(task.id, ["D"], AGENT),
      service.addGoals(task.id, ["E"], AGENT),
      service.addGoals(task.id, ["F"], AGENT, { requestId: "same" }),
      service.addGoals(task.id, ["F"], AGENT, { requestId: "same" }),
    ]);
    const detail = await service.getTaskDetail(task.id);
    const byTitle = Object.fromEntries(
      detail.goals.map((g) => [g.title, g.state])
    );
    expect(byTitle).toEqual({
      A: "completed",
      "B renamed": "open",
      C: "retired",
      D: "open",
      E: "open",
      F: "open",
    });
    expect(new Set(detail.goals.map((g) => g.position)).size).toBe(6);
    expect(detail.goalCounts).toEqual({ completed: 1, total: 5 });
    expect(await goalEvents(task.id)).toHaveLength(1 + 6);
  });
});

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: true;
  structuredContent?: Record<string, unknown>;
  content: Array<{ text: string }>;
}>;

function tools(agentProjectId: string) {
  const handlers = new Map<string, ToolHandler>();
  registerTaskTools(
    {
      registerTool: (name: string, _c: unknown, handler: ToolHandler) =>
        handlers.set(name, handler),
    } as never,
    new Set([
      "task_create",
      "task_get",
      "task_list",
      "task_goal_add",
      "task_goal_update",
    ]),
    {
      caller: AGENT,
      resolveProject: async () => agentProjectId,
      service,
    }
  );
  return (name: string, args: Record<string, unknown>) =>
    handlers.get(name)!(args);
}

describe("task goal tools", () => {
  it("creates with goals, returns ids/states and applies scoped edits", async () => {
    const call = tools(projectId);
    const created = await call("task_create", {
      title: "Via MCP",
      goals: ["First", "Second"],
    });
    expect(created.isError).not.toBe(true);
    const id = created.structuredContent!.id as string;
    const goals = created.structuredContent!.goals as Array<{
      id: string;
      title: string;
      state: string;
    }>;
    expect(goals.map((g) => [g.title, g.state])).toEqual([
      ["First", "open"],
      ["Second", "open"],
    ]);
    const got = await call("task_get", { id });
    expect(
      (got.structuredContent!.goals as Array<{ id: string }>).map((g) => g.id)
    ).toEqual(goals.map((g) => g.id));
    const updated = await call("task_goal_update", {
      id,
      changes: [{ goalId: goals[0]!.id, action: "complete" }],
    });
    expect(updated.structuredContent).toMatchObject({
      taskId: id,
      goalCounts: { completed: 1, total: 2 },
    });
    const added = await call("task_goal_add", { id, titles: ["Third"] });
    expect(added.structuredContent!.goalCounts).toEqual({
      completed: 1,
      total: 3,
    });
  });

  it("refuses another project's task and a goal from another task", async () => {
    const foreign = await newTask(["Theirs"], otherProjectId);
    const call = tools(projectId);
    for (const [name, args] of [
      ["task_goal_add", { id: foreign.id, titles: ["Mine"] }],
      [
        "task_goal_update",
        { id: foreign.id, changes: [{ goalId: "x", action: "complete" }] },
      ],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/another project/);
    }
    const own = await newTask(["Ours"]);
    const [theirs] = (await service.getTaskDetail(foreign.id)).goals;
    const crossTask = await call("task_goal_update", {
      id: own.id,
      changes: [{ goalId: theirs!.id, action: "complete" }],
    });
    expect(crossTask.isError).toBe(true);
    expect((await service.getTaskDetail(foreign.id)).goals[0]!.state).toBe(
      "open"
    );
  });
});
