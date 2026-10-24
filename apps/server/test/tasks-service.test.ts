import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";

import {
  buildTaskBriefing,
  mergeLinks,
  TaskError,
  TaskService,
  type TaskAgentInfo,
  type TaskLaunchRequest,
} from "../src/tasks/service.js";
import type { TemplateRecord } from "../src/templates/store.js";
import type { AgentRecord } from "../src/agents/types.js";
import { registerTaskTools } from "../src/shared/mcp/task-tools.js";
import { chatUrlSchema } from "../src/chat/validation.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

const REPO = "/repo/tasks";
const TEMPLATE_ID = "tpl_tasks";
const OTHER_TEMPLATE_ID = "tpl_elsewhere";

let projectId: string;
let otherProjectId: string;
let agents: Map<string, TaskAgentInfo>;
let launches: TaskLaunchRequest[];
let launchFails: string | null;
let posts: Array<{ streamId: string; input: Record<string, unknown> }>;
let agentPosts: Array<{ agentId: string; input: Record<string, unknown> }>;
let postFails: boolean;
let published: Array<{ type: string; projectId: string; taskId?: string }>;
let service: TaskService;
let agentSeq = 0;

function template(
  overrides: Partial<TemplateRecord> & { id: string }
): TemplateRecord {
  return {
    name: "Builder",
    projectId,
    directory: REPO,
    agentType: "claude",
    model: null,
    prompt: "Build {{D:Task ID}}",
    ...overrides,
  } as TemplateRecord;
}

async function insertAgent(
  id: string,
  status = "running",
  name = "Agent " + id
): Promise<void> {
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, $2, '/tmp', $3)`,
    [id, name, status]
  );
  agents.set(id, { id, name, status, projectId });
}

function build(): TaskService {
  return new TaskService({
    pool,
    getAgent: async (id) => agents.get(id) ?? null,
    getTemplate: async (id) =>
      id === TEMPLATE_ID
        ? template({ id })
        : id === OTHER_TEMPLATE_ID
          ? template({ id, projectId: otherProjectId })
          : null,
    launchTemplate: async (input) => {
      launches.push(input);
      if (launchFails) throw new Error(launchFails);
      const id = `agt_launch_${++agentSeq}`;
      await insertAgent(id, "running", "Builder");
      return { id } as AgentRecord;
    },
    chat: {
      streamOf: async (agentId: string) => `stream:${agentId}`,
      sendUserPost: (async (
        streamId: string,
        input: Record<string, unknown>
      ) => {
        if (postFails) throw new Error("inert");
        posts.push({ streamId, input });
        return {
          block: {
            id: `00000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}`,
          },
          delivered: null,
          held: false,
        };
      }) as never,
      post: (async (agentId: string, input: Record<string, unknown>) => {
        agentPosts.push({ agentId, input });
        return { id: "reply-block" };
      }) as never,
    },
    publishUiEvent: (event) => published.push(event),
    log: { warn: vi.fn(), info: vi.fn() },
  });
}

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
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Tasks', $1, '#336699') RETURNING id`,
      [REPO]
    )
  ).rows[0].id;
  otherProjectId = (
    await pool.query(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Other', '/repo/other', '#336699') RETURNING id`
    )
  ).rows[0].id;
  agents = new Map();
  launches = [];
  launchFails = null;
  posts = [];
  agentPosts = [];
  postFails = false;
  published = [];
  service = build();
});

async function columnId(key: string): Promise<string> {
  const board = await service.getBoard(projectId);
  return board.columns.find((c) => c.key === key)!.id;
}

async function withTrigger(
  key: string,
  trigger: Record<string, unknown> = {}
): Promise<string> {
  const id = await columnId(key);
  await service.updateColumn(id, {
    trigger: { templateId: TEMPLATE_ID, ...trigger },
  });
  return id;
}

const USER = { kind: "user" } as const;

describe("columns", () => {
  it("seeds the default columns once", async () => {
    const first = await service.getBoard(projectId);
    expect(first.columns.map((c) => [c.key, c.isDone])).toEqual([
      ["backlog", false],
      ["ready", false],
      ["in_progress", false],
      ["in_review", false],
      ["done", true],
    ]);
    await Promise.all([
      service.getBoard(projectId),
      service.getBoard(projectId),
    ]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM task_columns WHERE project_id = $1",
      [projectId]
    );
    expect(rows[0].n).toBe(5);
  });

  it("404s an unknown project", async () => {
    await expect(service.getBoard("nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("derives a unique key from the name", async () => {
    await service.getBoard(projectId);
    const a = await service.createColumn(projectId, { name: "QA Check" });
    const b = await service.createColumn(projectId, { name: "QA check!" });
    expect(a.key).toBe("qa_check");
    expect(b.key).toBe("qa_check_2");
    expect(a.position).toBe(5);
    await expect(
      service.createColumn(projectId, { name: "x", key: "backlog" })
    ).rejects.toMatchObject({ status: 409, code: "column_key_taken" });
  });

  it("keeps a single done column", async () => {
    const review = await columnId("in_review");
    await service.updateColumn(review, { isDone: true });
    const board = await service.getBoard(projectId);
    expect(board.columns.filter((c) => c.isDone).map((c) => c.key)).toEqual([
      "in_review",
    ]);
    const created = await service.createColumn(projectId, {
      name: "Shipped",
      isDone: true,
    });
    const after = await service.getBoard(projectId);
    expect(after.columns.filter((c) => c.isDone).map((c) => c.id)).toEqual([
      created.id,
    ]);
  });

  it("refuses to delete a column that holds tasks", async () => {
    const backlog = await columnId("backlog");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await expect(service.deleteColumn(backlog)).rejects.toMatchObject({
      status: 409,
      code: "column_not_empty",
    });
    await service.deleteTask(task.id);
    await service.deleteColumn(backlog);
    const board = await service.getBoard(projectId);
    expect(board.columns.map((c) => c.key)).not.toContain("backlog");
  });

  it("validates the trigger's template and model", async () => {
    const ready = await columnId("ready");
    await expect(
      service.updateColumn(ready, { trigger: { templateId: "missing" } })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.updateColumn(ready, {
        trigger: { templateId: OTHER_TEMPLATE_ID },
      })
    ).rejects.toThrow(/another project/);
    await expect(
      service.updateColumn(ready, {
        trigger: { templateId: TEMPLATE_ID, model: "no-such-model" },
      })
    ).rejects.toMatchObject({ status: 400 });
    const column = await service.updateColumn(ready, {
      trigger: { templateId: TEMPLATE_ID },
    });
    expect(column.trigger).toEqual({
      templateId: TEMPLATE_ID,
      agentType: null,
      model: null,
      assign: true,
      passContext: true,
      fireOnCreate: false,
    });
  });
});

describe("tasks", () => {
  it("creates at the top of the column, first column by default", async () => {
    const a = await service.createTask({ projectId, title: "a" }, USER);
    const b = await service.createTask({ projectId, title: "b" }, USER);
    expect(a.columnId).toBe(await columnId("backlog"));
    expect(b.position).toBeLessThan(a.position);
    expect(b.createdBy).toEqual({ kind: "user" });
  });

  it("sets and clears completedAt with the done column", async () => {
    const task = await service.createTask({ projectId, title: "a" }, USER);
    const done = await service.updateTask(
      task.id,
      { columnId: await columnId("done") },
      USER
    );
    expect(done.completedAt).not.toBeNull();
    const back = await service.updateTask(
      task.id,
      { columnId: await columnId("ready") },
      USER
    );
    expect(back.completedAt).toBeNull();
  });

  it("lists by assigned agent alone", async () => {
    await insertAgent("agt_a");
    const task = await service.createTask({ projectId, title: "a" }, USER);
    await service.createTask({ projectId, title: "b" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    const listed = await service.listTasks({ assignedAgentId: "agt_a" });
    expect(listed.map((t) => t.id)).toEqual([task.id]);
    await expect(service.listTasks({})).rejects.toBeInstanceOf(TaskError);
  });

  it("publishes task.changed on every write", async () => {
    const ready = await columnId("ready");
    published = [];
    const task = await service.createTask({ projectId, title: "a" }, USER);
    await service.updateTask(task.id, { title: "b" }, USER);
    await service.updateTask(task.id, { columnId: ready }, USER);
    await service.deleteTask(task.id);
    expect(published).toEqual([
      { type: "task.changed", projectId, taskId: task.id },
      { type: "task.changed", projectId, taskId: task.id },
      { type: "task.changed", projectId, taskId: task.id },
      { type: "task.changed", projectId, taskId: task.id },
    ]);
    await service.updateColumn(ready, { name: "Up next" });
    expect(published.at(-1)).toEqual({ type: "task.changed", projectId });
  });
});

describe("triggers", () => {
  it("fires once per entry, never on an edit inside the column", async () => {
    const ready = await withTrigger("ready", { assign: false });
    const task = await service.createTask({ projectId, title: "Fix it" }, USER);
    await service.updateTask(task.id, { columnId: ready }, USER);
    await service.updateTask(task.id, { title: "Fix it now" }, USER);
    await service.updateTask(task.id, { columnId: ready, position: 3 }, USER);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      templateId: TEMPLATE_ID,
      projectId,
      args: { "Task ID": task.id, "Task Title": "Fix it", "Task Body": "" },
    });
    expect(launches[0]!.appendix).toContain("## Dispatch task");
    const detail = await service.getTaskDetail(task.id);
    expect(detail.events.map((e) => e.kind)).toEqual([
      "created",
      "moved",
      "trigger_launched",
      "updated",
    ]);
    expect(detail.assignedAgentId).toBeNull();
  });

  it("leaves the briefing off without passContext", async () => {
    const ready = await withTrigger("ready", {
      passContext: false,
      assign: false,
    });
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { columnId: ready }, USER);
    expect(launches[0]!.appendix).toBeUndefined();
  });

  it("fires on create only with fireOnCreate", async () => {
    const ready = await withTrigger("ready");
    await service.createTask({ projectId, title: "t", columnId: ready }, USER);
    expect(launches).toHaveLength(0);
    await withTrigger("ready", { fireOnCreate: true });
    const task = await service.createTask(
      { projectId, title: "t2", columnId: ready },
      USER
    );
    expect(launches).toHaveLength(1);
    expect(task.assignedAgentId).toMatch(/^agt_launch_/);
  });

  it("records a failure without undoing the move", async () => {
    const ready = await withTrigger("ready");
    launchFails = "Template x not found.";
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const moved = await service.updateTask(task.id, { columnId: ready }, USER);
    expect(moved.columnId).toBe(ready);
    expect(moved.latestFailure).toMatchObject({
      reason: "Template x not found.",
    });
    const detail = await service.getTaskDetail(task.id);
    expect(detail.events.at(-1)).toMatchObject({
      kind: "trigger_failed",
      data: { templateId: TEMPLATE_ID, reason: "Template x not found." },
    });

    // A later successful launch clears the badge.
    launchFails = null;
    await service.updateTask(
      task.id,
      { columnId: await columnId("backlog") },
      USER
    );
    const again = await service.updateTask(task.id, { columnId: ready }, USER);
    expect(again.latestFailure).toBeNull();
  });

  it("refuses to relaunch over a working agent unless confirmed", async () => {
    const ready = await withTrigger("ready");
    const backlog = await columnId("backlog");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { columnId: ready }, USER);
    const first = (await service.requireTask(task.id)).assignedAgentId!;
    await service.updateTask(task.id, { columnId: backlog }, USER);

    await expect(
      service.updateTask(task.id, { columnId: ready }, USER)
    ).rejects.toMatchObject({
      status: 409,
      code: "agent_working",
      extra: { agent: { id: first, name: "Builder" } },
    });
    expect((await service.requireTask(task.id)).columnId).toBe(backlog);

    const relaunched = await service.updateTask(
      task.id,
      { columnId: ready, confirmRelaunch: true },
      USER
    );
    expect(relaunched.assignedAgentId).not.toBe(first);
    expect(launches).toHaveLength(2);
  });

  it("lets the assigned agent hand its own task on", async () => {
    const review = await withTrigger("in_review");
    await insertAgent("agt_builder");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_builder" }, USER);
    const moved = await service.updateTask(
      task.id,
      { columnId: review },
      { kind: "agent", agentId: "agt_builder" }
    );
    expect(moved.columnId).toBe(review);
    expect(launches).toHaveLength(1);
    // The reviewer takes over; the builder stays in the history.
    expect(moved.assignedAgentId).toMatch(/^agt_launch_/);
    const detail = await service.getTaskDetail(task.id);
    expect(detail.events.map((e) => e.kind)).toContain("trigger_launched");
    expect(detail.agents.map((a) => a.agentId)).toEqual([
      "agt_builder",
      moved.assignedAgentId,
    ]);
  });

  it("does not guard a stopped agent", async () => {
    const ready = await withTrigger("ready");
    await insertAgent("agt_idle", "stopped");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_idle" }, USER);
    await service.updateTask(task.id, { columnId: ready }, USER);
    expect(launches).toHaveLength(1);
  });
});

describe("assignment", () => {
  it("posts the task block and stores the conversation", async () => {
    const ready = await withTrigger("ready");
    const task = await service.createTask(
      { projectId, title: "Ship it" },
      USER
    );
    await service.updateTask(task.id, { columnId: ready }, USER);
    const detail = await service.getTaskDetail(task.id);
    const agentId = detail.assignedAgentId!;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      streamId: `stream:${agentId}`,
      input: {
        to: agentId,
        allowInert: true,
        attachments: [
          { type: "link", url: `/tasks?task=${task.id}`, title: "Ship it" },
        ],
      },
    });
    expect(posts[0]!.input.text).toContain(`Task ${task.id} — Ship it (Ready)`);
    expect(detail.agents).toEqual([
      expect.objectContaining({
        agentId,
        role: "trigger",
        columnId: ready,
        conversation: {
          streamId: `stream:${agentId}`,
          blockId: expect.any(String),
        },
      }),
    ]);
  });

  it("keeps the assignment when the post fails", async () => {
    await insertAgent("agt_a");
    postFails = true;
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const updated = await service.updateTask(
      task.id,
      { assignedAgentId: "agt_a" },
      USER
    );
    expect(updated.assignedAgentId).toBe("agt_a");
    const detail = await service.getTaskDetail(task.id);
    expect(detail.agents[0]).toMatchObject({
      role: "manual",
      conversation: null,
    });
  });

  it("unassigning keeps the history row", async () => {
    await insertAgent("agt_a");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    const cleared = await service.updateTask(
      task.id,
      { assignedAgentId: null },
      USER
    );
    expect(cleared.assignedAgentId).toBeNull();
    const detail = await service.getTaskDetail(task.id);
    expect(detail.agents.map((a) => a.agentId)).toEqual(["agt_a"]);
    expect(detail.events.at(-1)).toMatchObject({
      kind: "unassigned",
      data: { agentId: "agt_a", role: "manual" },
    });
  });

  it("launches by hand with role manual", async () => {
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const { agent } = await service.launchAgent(
      task.id,
      { templateId: TEMPLATE_ID },
      USER
    );
    const detail = await service.getTaskDetail(task.id);
    expect(detail.assignedAgentId).toBe(agent.id);
    expect(detail.agents[0]!.role).toBe("manual");
    expect(detail.events.map((e) => e.kind)).toContain("agent_launched");
    await expect(
      service.launchAgent(task.id, { templateId: OTHER_TEMPLATE_ID }, USER)
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("helpers", () => {
  it("builds the briefing", () => {
    const text = buildTaskBriefing({
      task: {
        id: "tsk_1",
        title: "T",
        body: "Do it",
        links: [{ kind: "pr", url: "https://x/pr/1", label: "PR #1" }],
      },
      project: { name: "P", repoRoot: "/r" },
      column: { name: "Ready" },
    });
    expect(text).toContain("Task: tsk_1 — T\nProject: P (/r)\nColumn: Ready");
    expect(text).toContain("Links:\n- PR #1: https://x/pr/1");
    expect(text).toContain("Do it");
    expect(
      buildTaskBriefing({
        task: { id: "t", title: "T", body: "", links: [] },
        project: { name: "P", repoRoot: "/r" },
        column: { name: "C" },
      })
    ).toContain("Links: none");
  });

  it("merges links by url", () => {
    const a = { kind: "pr" as const, url: "https://a", label: "A" };
    const b = { kind: "url" as const, url: "https://b", label: "B" };
    expect(mergeLinks([a], [a, b])).toEqual({ links: [a, b], added: [b] });
  });

  it("accepts app paths as link urls but not other hosts", () => {
    expect(chatUrlSchema.safeParse("/tasks?task=tsk_1").success).toBe(true);
    expect(chatUrlSchema.safeParse("//evil.example").success).toBe(false);
    expect(chatUrlSchema.safeParse("/\\evil.example").success).toBe(false);
    expect(chatUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(chatUrlSchema.safeParse("tasks?task=tsk_1").success).toBe(false);
  });
});

// ── MCP tools ───────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
}>;

function tools(agentId: string, agentProjectId: string | null) {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerTaskTools(
    server as never,
    new Set([
      "task_list",
      "task_get",
      "task_create",
      "task_update",
      "task_comment",
    ]),
    { agentId, projectId: agentProjectId, service }
  );
  return (name: string, args: Record<string, unknown>) =>
    handlers.get(name)!(args);
}

describe("task tools", () => {
  it("defaults to the caller's project and errors without one", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const created = await call("task_create", { title: "From a tool" });
    expect(created.structuredContent).toMatchObject({ column: "backlog" });
    const task = await service.requireTask(
      created.structuredContent!.id as string
    );
    expect(task.createdBy).toEqual({ kind: "agent", agentId: "agt_tool" });

    const listed = await call("task_list", {});
    expect(listed.structuredContent!.tasks).toEqual([
      expect.objectContaining({ id: task.id, column: "backlog" }),
    ]);

    const nowhere = tools("agt_tool", null);
    const refused = await nowhere("task_create", { title: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Pass projectId/);
  });

  it("assign self posts the block into the caller's stream", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const result = await call("task_update", {
      id: task.id,
      assign: "self",
      links: [
        { kind: "pr", url: "https://github.com/o/r/pull/1", label: "PR" },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      assignedAgentId: "agt_tool",
      links: [{ url: "https://github.com/o/r/pull/1" }],
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.streamId).toBe("stream:agt_tool");
    const detail = await service.getTaskDetail(task.id);
    expect(detail.agents[0]).toMatchObject({ role: "self" });
    expect(detail.events.map((e) => e.kind)).toContain("link_added");

    // Appending the same link again is a no-op.
    await call("task_update", {
      id: task.id,
      links: [
        { kind: "pr", url: "https://github.com/o/r/pull/1", label: "PR" },
      ],
    });
    expect((await service.requireTask(task.id)).links).toHaveLength(1);
  });

  it("task_comment needs an assignment, then replies in its thread", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const refused = await call("task_comment", { id: task.id, text: "hi" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/assign: "self"/);

    await call("task_update", { id: task.id, assign: "self" });
    const ok = await call("task_comment", { id: task.id, text: "progress" });
    expect(ok.isError).toBeUndefined();
    const blockId = (await service.getTaskDetail(task.id)).agents[0]!
      .conversation!.blockId;
    expect(agentPosts).toEqual([
      { agentId: "agt_tool", input: { text: "progress", replyTo: blockId } },
    ]);
  });

  it("refuses a move that would relaunch over another running agent", async () => {
    await withTrigger("ready");
    await insertAgent("agt_tool");
    await insertAgent("agt_busy");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_busy" }, USER);
    const call = tools("agt_tool", projectId);
    const result = await call("task_update", { id: task.id, column: "ready" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "agent_working" },
    });
    expect(launches).toHaveLength(0);

    const unknown = await call("task_update", { id: task.id, column: "nope" });
    expect(unknown.content[0]!.text).toMatch(/Columns: backlog, ready/);
  });

  it("task_get caps events at 30", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    for (let i = 0; i < 35; i++)
      await service.updateTask(task.id, { title: `t${i}` }, USER);
    const result = await call("task_get", { id: task.id });
    const events = result.structuredContent!.events as Array<{
      data: { fields: string[] };
    }>;
    expect(events).toHaveLength(30);
    expect((await service.getTaskDetail(task.id)).events).toHaveLength(36);
  });
});
