import Fastify from "fastify";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startupFileUpload } from "../src/routes/agent-startup.js";
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
let filesRoot: string;

const REPO = "/repo/tasks";
const TEMPLATE_ID = "tpl_tasks";
const OTHER_TEMPLATE_ID = "tpl_elsewhere";
const FULL_TEMPLATE_ID = "tpl_full";

let projectId: string;
let otherProjectId: string;
let agents: Map<string, TaskAgentInfo>;
let launches: TaskLaunchRequest[];
let launchFails: string | null;
/** When set, launches wait for it before creating their agent. */
let launchGate: Promise<void> | null;
let posts: Array<{ streamId: string; input: Record<string, unknown> }>;
let agentPosts: Array<{
  agentId: string;
  input: Record<string, unknown>;
  opts: Record<string, unknown>;
}>;
let postFails: boolean;
let withdrawals: Array<{ streamId: string; agentId: string }>;
let withdrawFails: boolean;
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

function build(storageRoot = filesRoot): TaskService {
  return new TaskService({
    pool,
    filesRoot: storageRoot,
    getAgent: async (id) => agents.get(id) ?? null,
    getTemplate: async (id) =>
      id === TEMPLATE_ID
        ? template({ id })
        : id === OTHER_TEMPLATE_ID
          ? template({ id, projectId: otherProjectId })
          : id === FULL_TEMPLATE_ID
            ? template({ id, fullAccess: true })
            : null,
    launchTemplate: async (input) => {
      launches.push(input);
      if (launchGate) await launchGate;
      if (launchFails) throw new Error(launchFails);
      const id = `agt_launch_${++agentSeq}`;
      await insertAgent(id, "running", "Builder");
      return { id } as AgentRecord;
    },
    chat: {
      closeStream: async () => {},
      releaseStream: () => {},
      withdrawDeliveries: async (streamId: string, agentId: string) => {
        withdrawals.push({ streamId, agentId });
        if (withdrawFails) throw new Error("in flight");
        return () => {};
      },
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
      post: (async (
        agentId: string,
        input: Record<string, unknown>,
        opts: Record<string, unknown>
      ) => {
        agentPosts.push({ agentId, input, opts });
        return { id: "reply-block" };
      }) as never,
    },
    publishUiEvent: (event) => published.push(event),
    log: { warn: vi.fn(), info: vi.fn() },
  });
}

beforeAll(async () => {
  filesRoot = await mkdtemp(path.join(tmpdir(), "task-attachments-test-"));
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
  await rm(filesRoot, { recursive: true, force: true });
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
  launchGate = null;
  posts = [];
  agentPosts = [];
  postFails = false;
  withdrawals = [];
  withdrawFails = false;
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
      args: { "task id": task.id, "task title": "Fix it", "task body": "" },
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

  it("always appends the task briefing, assigning or not", async () => {
    const ready = await withTrigger("ready", { assign: false });
    const task = await service.createTask(
      { projectId, title: "Ship it", body: "Acceptance: it ships." },
      USER
    );
    await service.updateTask(task.id, { columnId: ready }, USER);
    expect(launches[0]!.appendix).toContain(task.id);
    expect(launches[0]!.appendix).toContain("Ship it");
    expect(launches[0]!.appendix).toContain("Acceptance: it ships.");
    expect(launches[0]!.appendix).toContain(
      'Columns: backlog → ready (you are here; launches "Builder") → in_progress'
    );
  });

  it("removes an agent from the task, unassigning it if current", async () => {
    await insertAgent("agt_a");
    await insertAgent("agt_idle");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_idle" }, USER);
    const afterPast = await service.removeAgent(task.id, "agt_a", USER);
    expect(afterPast.assignedAgentId).toBe("agt_idle");
    expect(afterPast.agents.map((a) => a.agentId)).toEqual(["agt_idle"]);
    const afterCurrent = await service.removeAgent(task.id, "agt_idle", USER);
    expect(afterCurrent.assignedAgentId).toBeNull();
    expect(afterCurrent.agents).toEqual([]);
    // Anything of the task still queued at either agent was taken back first.
    expect(withdrawals).toEqual([
      { streamId: task.id, agentId: "agt_a" },
      { streamId: task.id, agentId: "agt_idle" },
    ]);
    expect(afterCurrent.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["agent_removed", "unassigned"])
    );
    await expect(
      service.removeAgent(task.id, "agt_a", USER)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the agent on the task while a delivery to it is in flight", async () => {
    await insertAgent("agt_a");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    withdrawFails = true;
    await expect(
      service.removeAgent(task.id, "agt_a", USER)
    ).rejects.toMatchObject({ status: 409, code: "delivery_in_flight" });
    const detail = await service.getTaskDetail(task.id);
    expect(detail.assignedAgentId).toBe("agt_a");
    expect(detail.agents.map((a) => a.agentId)).toEqual(["agt_a"]);
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
  it("posts the assignment into the task's stream", async () => {
    const ready = await withTrigger("ready");
    // The title names another agent: the block must still go to the assignee.
    const task = await service.createTask(
      { projectId, title: "Ship it with @Reviewer" },
      USER
    );
    await service.updateTask(task.id, { columnId: ready }, USER);
    const detail = await service.getTaskDetail(task.id);
    const agentId = detail.assignedAgentId!;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      streamId: task.id,
      input: {
        to: agentId,
        text: `You're assigned to task ${task.id} — Ship it with @Reviewer. This stream is the task's conversation; reply here.`,
        allowInert: true,
        resolveMentions: false,
      },
    });
    expect(detail.agents).toEqual([
      expect.objectContaining({ agentId, role: "trigger", columnId: ready }),
    ]);
    expect(detail.agents[0]).not.toHaveProperty("conversation");
    // The launch briefing names the task's stream.
    expect(launches[0]!.appendix).toContain(`Conversation: stream ${task.id}`);
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
    expect(detail.agents[0]).toMatchObject({ role: "manual" });
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
      column: { key: "ready", name: "Ready" },
      columns: [
        { key: "backlog", name: "Backlog", isDone: false, trigger: null },
        { key: "ready", name: "Ready", isDone: false, trigger: null },
        {
          key: "in_review",
          name: "In review",
          isDone: false,
          trigger: { templateName: "Code review" },
        },
        { key: "done", name: "Done", isDone: true, trigger: null },
      ],
    });
    expect(text).toContain("Task: tsk_1 — T\nProject: P (/r)\nColumn: Ready");
    expect(text).toContain(
      'Columns: backlog → ready (you are here) → in_review (launches "Code review") → done (completes the task)\n' +
        'Move it with task_update({ id, column: "<key>" }) as the work changes state; moving into a column with a trigger launches that agent.'
    );
    expect(text).toContain("Links:\n- PR #1: https://x/pr/1");
    expect(text).toContain("Do it");
    expect(
      buildTaskBriefing({
        task: { id: "t", title: "T", body: "", links: [] },
        project: { name: "P", repoRoot: "/r" },
        column: { key: "c", name: "C" },
        columns: [
          {
            key: "c",
            name: "C",
            isDone: true,
            trigger: { templateName: "X" },
          },
          {
            key: "gone",
            name: "Gone",
            isDone: false,
            trigger: { templateName: null },
          },
        ],
      })
    ).toContain(
      'Links: none\n\n(no description)\n\nColumns: c (you are here; launches "X"; completes the task) → ' +
        "gone (its trigger's template is missing, so nothing launches)"
    );
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
    // URL parsing strips tabs and newlines, which would make these
    // protocol-relative: "/\t/host" → "//host".
    expect(chatUrlSchema.safeParse("/\t/evil.example").success).toBe(false);
    expect(chatUrlSchema.safeParse("/\n/evil.example").success).toBe(false);
    expect(chatUrlSchema.safeParse("/tasks\r?task=1").success).toBe(false);
  });
});

// ── MCP tools ───────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
}>;

function tools(
  agentId: string,
  agentProjectId: string | null,
  opts: { fullAccess?: boolean; paths?: string[] } = {}
) {
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
    {
      caller: { kind: "agent", agentId, fullAccess: opts.fullAccess },
      resolveProject: () =>
        service.projectForAgent({
          projectId: agentProjectId,
          paths: opts.paths ?? [],
        }),
      service,
    }
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
    expect(refused.content[0]!.text).toMatch(/not in a Dispatch project/);
  });

  it("assign self posts the assignment into the task's stream", async () => {
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
    expect(posts[0]!.streamId).toBe(task.id);
    expect(posts[0]!.input.to).toBe("agt_tool");
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

  it("task_comment needs an assignment, then posts in the task's stream", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const refused = await call("task_comment", { id: task.id, text: "hi" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/assign: "self"/);

    await call("task_update", { id: task.id, assign: "self" });
    const ok = await call("task_comment", { id: task.id, text: "progress" });
    expect(ok.isError).toBeUndefined();
    expect(agentPosts).toEqual([
      {
        agentId: "agt_tool",
        input: { text: "progress" },
        opts: { root: task.id },
      },
    ]);

    // `to` must name another agent on the task.
    await insertAgent("agt_other");
    const stranger = await call("task_comment", {
      id: task.id,
      text: "hi",
      to: "agt_other",
    });
    expect(stranger.isError).toBe(true);
    expect(stranger.content[0]!.text).toMatch(/not on task/);
    await service.updateTask(task.id, { assignedAgentId: "agt_other" }, USER);
    await call("task_comment", {
      id: task.id,
      text: "over to you",
      to: "agt_other",
    });
    expect(agentPosts.at(-1)).toEqual({
      agentId: "agt_tool",
      input: { text: "over to you", to: "agt_other" },
      opts: { root: task.id },
    });
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
    expect(result.structuredContent!.column).toBe("backlog");
    const events = result.structuredContent!.events as Array<{
      data: { fields: string[] };
    }>;
    expect(events).toHaveLength(30);
    expect((await service.getTaskDetail(task.id)).events).toHaveLength(36);
  });
});

// ── Review follow-ups ───────────────────────────────────────────────

describe("concurrent transitions", () => {
  it("fires once when the same move lands twice at once", async () => {
    const ready = await withTrigger("ready");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await Promise.all([
      service.updateTask(task.id, { columnId: ready }, USER),
      service.updateTask(task.id, { columnId: ready }, USER),
    ]);
    expect(launches).toHaveLength(1);
    const kinds = (await service.getTaskDetail(task.id)).events.map(
      (e) => e.kind
    );
    expect(kinds.filter((k) => k === "moved")).toHaveLength(1);
  });

  it("serializes a newer move behind a slow launch", async () => {
    const ready = await withTrigger("ready");
    const backlog = await columnId("backlog");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    let open!: () => void;
    launchGate = new Promise((resolve) => (open = resolve));
    const first = service.updateTask(task.id, { columnId: ready }, USER);
    const second = service.updateTask(
      task.id,
      { columnId: backlog, confirmRelaunch: true },
      USER
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The newer move is waiting on the launch, not racing it.
    expect((await service.requireTask(task.id)).columnId).toBe(ready);
    open();
    await Promise.all([first, second]);
    const final = await service.requireTask(task.id);
    expect(final.columnId).toBe(backlog);
    const kinds = (await service.getTaskDetail(task.id)).events.map(
      (e) => e.kind
    );
    expect(kinds.slice(-2)).toEqual(["assigned", "moved"]);
  });

  it("a launch that finds the task moved away does not assign", async () => {
    await withTrigger("ready");
    const ready = await columnId("ready");
    const backlog = await columnId("backlog");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    let open!: () => void;
    launchGate = new Promise((resolve) => (open = resolve));
    const move = service.updateTask(task.id, { columnId: ready }, USER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A write from outside this process's lock moves it on mid-launch.
    await pool.query("UPDATE tasks SET column_id = $2 WHERE id = $1", [
      task.id,
      backlog,
    ]);
    open();
    const after = await move;
    expect(launches).toHaveLength(1);
    expect(after.assignedAgentId).toBeNull();
    expect(posts).toHaveLength(0);
    const kinds = (await service.getTaskDetail(task.id)).events.map(
      (e) => e.kind
    );
    expect(kinds).toContain("trigger_launched");
    expect(kinds).not.toContain("assigned");
  });

  it("skips a move whose source column changed underneath it", async () => {
    const ready = await withTrigger("ready");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const moved = await service.store.updateTask(
      task.id,
      { columnId: ready },
      { fromColumnId: "tcol_not_its_column" }
    );
    expect(moved).toBe(false);
    expect((await service.requireTask(task.id)).columnId).toBe(task.columnId);
  });

  it("posts one assignment for two overlapping self-assignments", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await Promise.all([
      call("task_update", { id: task.id, assign: "self" }),
      call("task_update", { id: task.id, assign: "self" }),
    ]);
    expect(posts).toHaveLength(1);
  });
});

describe("access ceiling", () => {
  it("a restricted agent's move cannot launch a full-access template", async () => {
    const ready = await columnId("ready");
    await service.updateColumn(ready, {
      trigger: { templateId: FULL_TEMPLATE_ID },
    });
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const result = await call("task_update", { id: task.id, column: "ready" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      column: "ready",
      latestFailure: {
        reason: "restricted agent cannot launch a full-access template",
      },
    });
    expect(launches).toHaveLength(0);
  });

  it("a restricted agent's fireOnCreate cannot launch one either", async () => {
    const ready = await columnId("ready");
    await service.updateColumn(ready, {
      trigger: { templateId: FULL_TEMPLATE_ID, fireOnCreate: true },
    });
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const created = await call("task_create", { title: "t", column: "ready" });
    const task = await service.requireTask(
      created.structuredContent!.id as string
    );
    expect(task.columnId).toBe(ready);
    expect(task.latestFailure?.reason).toBe(
      "restricted agent cannot launch a full-access template"
    );
    expect(launches).toHaveLength(0);
  });

  it("full-access agents and people may", async () => {
    const ready = await columnId("ready");
    await service.updateColumn(ready, {
      trigger: { templateId: FULL_TEMPLATE_ID, assign: false },
    });
    await insertAgent("agt_full");
    const call = tools("agt_full", projectId, { fullAccess: true });
    const a = await service.createTask({ projectId, title: "a" }, USER);
    await call("task_update", { id: a.id, column: "ready" });
    const b = await service.createTask({ projectId, title: "b" }, USER);
    await service.updateTask(b.id, { columnId: ready }, USER);
    expect(launches).toHaveLength(2);
  });

  it("holds for a manual launch by an agent", async () => {
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await expect(
      service.launchAgent(
        task.id,
        { templateId: FULL_TEMPLATE_ID },
        { kind: "agent", agentId: "agt_x" }
      )
    ).rejects.toThrow(/restricted agent/);
    expect(launches).toHaveLength(0);
  });
});

describe("tool project scope", () => {
  it("refuses another project's board and tasks", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const theirs = await service.createTask(
      { projectId: otherProjectId, title: "theirs" },
      USER
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      ["task_list", { projectId: otherProjectId }],
      ["task_create", { title: "x", projectId: otherProjectId }],
      ["task_get", { id: theirs.id }],
      ["task_update", { id: theirs.id, title: "mine now" }],
      ["task_comment", { id: theirs.id, text: "hi" }],
    ];
    for (const [name, args] of cases) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text, name).toMatch(/own project/);
    }
    expect((await service.requireTask(theirs.id)).title).toBe("theirs");
  });

  it("places a projectless agent by its workspace", async () => {
    await insertAgent("agt_loose");
    const call = tools("agt_loose", null, {
      paths: [`${REPO}/packages/app`],
    });
    const created = await call("task_create", { title: "found my board" });
    expect(
      (await service.requireTask(created.structuredContent!.id as string))
        .projectId
    ).toBe(projectId);
    const lost = tools("agt_loose", null, { paths: ["/elsewhere"] });
    expect((await lost("task_list", {})).isError).toBe(true);
  });
});

describe("assign self", () => {
  it("cannot take over a running agent's task", async () => {
    await withTrigger("ready");
    await insertAgent("agt_a");
    await insertAgent("agt_b");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    posts = [];
    const call = tools("agt_b", projectId);
    const result = await call("task_update", {
      id: task.id,
      assign: "self",
      column: "ready",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "agent_working" },
    });
    const after = await service.requireTask(task.id);
    expect(after.assignedAgentId).toBe("agt_a");
    expect(after.columnId).toBe(task.columnId);
    expect(launches).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("cannot take it over without a move either", async () => {
    await insertAgent("agt_a");
    await insertAgent("agt_b");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    posts = [];
    const call = tools("agt_b", projectId);
    const result = await call("task_update", { id: task.id, assign: "self" });
    expect(result.isError).toBe(true);
    expect((await service.requireTask(task.id)).assignedAgentId).toBe("agt_a");
    expect(posts).toHaveLength(0);

    // Once agt_a has stopped, agt_b may pick the task up.
    agents.set("agt_a", { ...agents.get("agt_a")!, status: "stopped" });
    await call("task_update", { id: task.id, assign: "self" });
    expect((await service.requireTask(task.id)).assignedAgentId).toBe("agt_b");
  });
});

describe("agents created for a task", () => {
  it("briefs on the task and assigns the created agent", async () => {
    await insertAgent("agt_new");
    const task = await service.createTask(
      { projectId, title: "Wire it", body: "Do the thing." },
      USER
    );
    await withTrigger("in_review");
    const briefing = await service.briefingFor(task.id);
    expect(briefing.projectId).toBe(projectId);
    expect(briefing.text).toContain(task.id);
    expect(briefing.text).toContain(
      'Columns: backlog (you are here) → ready → in_progress → in_review (launches "Builder") → done (completes the task)'
    );
    // A deleted template leaves its id in the trigger; the move would fail.
    await pool.query(
      `UPDATE task_columns SET trigger = jsonb_set(trigger, '{templateId}', '"tpl_deleted"') WHERE id = $1`,
      [await columnId("in_review")]
    );
    expect((await service.briefingFor(task.id)).text).toContain(
      "in_review (its trigger's template is missing, so nothing launches)"
    );
    expect(briefing.text).toContain("Do the thing.");
    posts = [];
    await service.assignCreated(task.id, "agt_new");
    const detail = await service.getTaskDetail(task.id);
    expect(detail.assignedAgentId).toBe("agt_new");
    expect(detail.agents.map((a) => a.role)).toEqual(["manual"]);
    // Its first prompt carries the briefing; no assignment post is queued
    // to start a turn before the engine is up.
    expect(posts).toEqual([]);
    await expect(service.briefingFor("tsk_missing")).rejects.toMatchObject({
      status: 404,
    });
  });
});

it("stores task attachments and links, briefs agents, and cleans up on deletion", async () => {
  const buffer = Buffer.from("# Task context\nRead me");
  const task = await service.createTask(
    { projectId, title: "With context" },
    { kind: "user" },
    {
      startupFiles: [startupFileUpload("context.md", "context.md", buffer)],
      startupLinks: [
        "https://example.com/context",
        "https://example.com/context",
      ],
    }
  );
  const detail = await service.getTaskDetail(task.id);
  expect(detail.attachments).toEqual([
    expect.objectContaining({
      name: "context.md",
      mimeType: "text/markdown",
      size: buffer.length,
    }),
  ]);
  expect(task.links).toEqual([
    {
      kind: "url",
      url: "https://example.com/context",
      label: "https://example.com/context",
    },
  ]);
  const attachment = await service.attachmentFile(
    task.id,
    detail.attachments[0]!.id
  );
  expect(await readFile(attachment.path)).toEqual(buffer);
  expect((await service.briefingFor(task.id)).text).toContain(
    `context.md (text/markdown) — ${attachment.path}`
  );
  await service.launchAgent(
    task.id,
    { templateId: TEMPLATE_ID },
    { kind: "user" }
  );
  expect(launches[0]!.appendix).toContain(attachment.path);
  await service.deleteTask(task.id);
  await expect(
    readdir(path.join(filesRoot, "tasks", task.id))
  ).rejects.toThrow();
  expect(
    (
      await pool.query("SELECT * FROM task_attachments WHERE task_id = $1", [
        task.id,
      ])
    ).rowCount
  ).toBe(0);
});

it("validates context before creating a task and rolls back a failed disk write", async () => {
  await expect(
    service.createTask(
      { projectId, title: "Invalid" },
      { kind: "user" },
      { startupLinks: ["file:///tmp/private"] }
    )
  ).rejects.toThrow("http or https");
  const blockedRoot = path.join(filesRoot, "blocked");
  await writeFile(blockedRoot, "not a directory");
  const failing = build(blockedRoot);
  await expect(
    failing.createTask(
      { projectId, title: "Disk failure" },
      { kind: "user" },
      {
        startupFiles: [
          startupFileUpload(
            "context.txt",
            "context.txt",
            Buffer.from("context")
          ),
        ],
      }
    )
  ).rejects.toThrow();
  expect(await service.listTasks({ projectId })).toEqual([]);
});

it("removes partially written attachments when attachment storage fails", async () => {
  const insert = service.store.insertAttachment.bind(service.store);
  const write = vi
    .spyOn(service.store, "insertAttachment")
    .mockImplementationOnce(insert)
    .mockRejectedValueOnce(new Error("attachment row unavailable"));
  const before = await readdir(path.join(filesRoot, "tasks")).catch(() => []);
  await expect(
    service.createTask(
      { projectId, title: "Partial" },
      { kind: "user" },
      {
        startupFiles: ["first.txt", "second.txt"].map((name) =>
          startupFileUpload(name, name, Buffer.from("context"))
        ),
      }
    )
  ).rejects.toThrow("attachment row unavailable");
  write.mockRestore();
  expect(await service.listTasks({ projectId })).toEqual([]);
  expect(await readdir(path.join(filesRoot, "tasks"))).toEqual(before);
  expect((await pool.query("SELECT * FROM task_attachments")).rowCount).toBe(0);
});

it("deleting a project cleans up its task attachment directories after cascading the rows", async () => {
  const task = await service.createTask(
    { projectId, title: "Project context" },
    { kind: "user" },
    {
      startupFiles: [
        startupFileUpload("context.txt", "context.txt", Buffer.from("context")),
      ],
    }
  );
  const detail = await service.getTaskDetail(task.id);
  const dir = path.join(filesRoot, "tasks", task.id);
  expect(await readdir(dir)).toHaveLength(1);
  const app = Fastify();
  try {
    await registerProjectRoutes(app, {
      pool,
      taskService: service,
      publishUiEvent: () => {},
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await expect(readdir(dir)).rejects.toThrow();
    expect(await service.store.getTask(task.id)).toBeNull();
    expect(
      (
        await pool.query("SELECT * FROM task_attachments WHERE id = $1", [
          detail.attachments[0]!.id,
        ])
      ).rowCount
    ).toBe(0);
  } finally {
    await app.close();
  }
});
