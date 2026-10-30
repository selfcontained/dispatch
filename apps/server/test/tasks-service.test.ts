import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerTaskRoutes } from "../src/routes/tasks.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { TaskStore } from "../src/tasks/store.js";

import {
  buildTaskBriefing,
  mergeLinks,
  TaskError,
  TaskService,
  type TaskAgentInfo,
  type TaskLaunchRequest,
} from "../src/tasks/service.js";
import type { TemplateRecord } from "../src/templates/store.js";
import { TemplateService } from "../src/templates/service.js";
import type { AgentRecord } from "../src/agents/types.js";
import { registerTaskTools } from "../src/shared/mcp/task-tools.js";
import { agentTaskProject, taskScopeInput } from "../src/tasks/agent-scope.js";
import { chatUrlSchema } from "../src/chat/validation.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";
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
let launchEntered: (() => void) | null;
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

function build(
  storageRoot = filesRoot,
  overrides: Partial<ConstructorParameters<typeof TaskService>[0]> = {}
): TaskService {
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
      launchEntered?.();
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
    ...overrides,
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
  launchEntered = null;
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

describe("relative task ordering", () => {
  it("serializes numeric rank writes with a relative reorder paused after reading siblings", async () => {
    const tasks = [];
    for (const [position, title] of ["a", "b", "c", "d"].entries())
      tasks.push(
        await service.createTask({ projectId, title, position }, USER)
      );
    let reached!: () => void;
    let release!: () => void;
    const selected = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalReorder = TaskStore.prototype.reorderTask;
    const originalLock = TaskStore.prototype.lockColumn;
    let watchingNumeric = false;
    let numericLockRequested = false;
    const lockSpy = vi
      .spyOn(TaskStore.prototype, "lockColumn")
      .mockImplementation(function (this: TaskStore, ...args) {
        if (watchingNumeric) numericLockRequested = true;
        return originalLock.apply(this, args);
      });
    const reorderSpy = vi
      .spyOn(TaskStore.prototype, "reorderTask")
      .mockImplementation(function (
        this: TaskStore,
        id,
        columnId,
        beforeId,
        db
      ) {
        const gatedDb = new Proxy(db, {
          get(target, key) {
            if (key === "query")
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(target.query, target, args);
                if (
                  typeof args[0] === "string" &&
                  args[0].includes("SELECT id FROM tasks WHERE column_id")
                ) {
                  reached();
                  await gate;
                }
                return result;
              };
            return Reflect.get(target, key);
          },
        });
        return originalReorder.call(this, id, columnId, beforeId, gatedDb);
      });
    let numericDone = false;
    const relative = build().updateTask(
      tasks[3]!.id,
      { beforeId: tasks[2]!.id },
      USER
    );
    let numeric: ReturnType<TaskService["updateTask"]> | undefined;
    try {
      await selected;
      watchingNumeric = true;
      numeric = build()
        .updateTask(tasks[0]!.id, { position: 10 }, USER)
        .then((task) => {
          numericDone = true;
          return task;
        });
      await vi.waitFor(() =>
        expect(numericDone || numericLockRequested).toBe(true)
      );
      expect(numericDone).toBe(false);
      release();
      await Promise.all([relative, numeric]);
      expect(
        (await service.getBoard(projectId)).tasks.map((task) => task.id)
      ).toEqual([tasks[1]!.id, tasks[3]!.id, tasks[2]!.id, tasks[0]!.id]);
      expect((await service.requireTask(tasks[0]!.id)).position).toBe(10);
    } finally {
      release();
      await Promise.allSettled([relative, ...(numeric ? [numeric] : [])]);
      reorderSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  it("rejects self/foreign anchors atomically and gives relative order precedence over numeric positions", async () => {
    const a = await service.createTask(
      { projectId, title: "a", position: 0 },
      USER
    );
    const b = await service.createTask(
      { projectId, title: "b", position: 1 },
      USER
    );
    const foreign = await service.createTask(
      { projectId, title: "foreign", columnId: await columnId("ready") },
      USER
    );
    for (const beforeId of [a.id, foreign.id, "missing"]) {
      await expect(
        service.updateTask(
          a.id,
          { beforeId, title: "changed", position: -99 },
          USER
        )
      ).rejects.toMatchObject({ status: 400 });
      expect(await service.requireTask(a.id)).toMatchObject({
        title: "a",
        position: 0,
      });
    }
    await service.updateTask(
      a.id,
      { beforeId: null, title: "changed", position: -99 },
      USER
    );
    expect(
      (await service.getBoard(projectId)).tasks
        .filter((task) => task.columnId === a.columnId)
        .map((task) => task.id)
    ).toEqual([b.id, a.id]);
    expect(await service.requireTask(a.id)).toMatchObject({
      title: "changed",
      position: 1,
    });
  });

  it("serializes opposing relative moves and sibling reorders without deadlocking", async () => {
    const backlog = await columnId("backlog");
    const ready = await columnId("ready");
    const a = await service.createTask(
      { projectId, title: "a", columnId: backlog },
      USER
    );
    const b = await service.createTask(
      { projectId, title: "b", columnId: ready },
      USER
    );
    const sibling = await service.createTask(
      { projectId, title: "sibling", columnId: backlog },
      USER
    );
    await Promise.all([
      build().updateTask(a.id, { columnId: ready, beforeId: null }, USER),
      build().updateTask(b.id, { columnId: backlog, beforeId: null }, USER),
      build().updateTask(
        sibling.id,
        { columnId: backlog, beforeId: null },
        USER
      ),
    ]);
    expect(await service.requireTask(a.id)).toMatchObject({ columnId: ready });
    expect(await service.requireTask(b.id)).toMatchObject({
      columnId: backlog,
    });
    const tasks = (await service.getBoard(projectId)).tasks.filter(
      (task) => task.columnId === backlog
    );
    expect(new Set(tasks.map((task) => task.position)).size).toBe(tasks.length);
  });

  it("persists insertions across tied and exhausted positions without launching on same-column reorder", async () => {
    const ready = await withTrigger("ready");
    const tasks = [];
    for (const title of ["a", "b", "c", "d"])
      tasks.push(
        await service.createTask(
          { projectId, title, columnId: ready, position: 1 },
          USER
        )
      );
    const original = (await service.getBoard(projectId)).tasks.map(
      (task) => task.id
    );
    const moving = original[3]!;
    await pool.query("UPDATE tasks SET position = $2 WHERE id = $1", [
      moving,
      1 + Number.EPSILON,
    ]);
    for (let n = 0; n < 60; n++) {
      await service.updateTask(
        moving,
        { columnId: ready, beforeId: original[1]! },
        USER
      );
      expect(
        (await service.getBoard(projectId)).tasks.map((task) => task.id)
      ).toEqual([original[0], moving, original[1], original[2]]);
      await service.updateTask(
        moving,
        { columnId: ready, beforeId: null },
        USER
      );
      expect(
        (await service.getBoard(projectId)).tasks.map((task) => task.id)
      ).toEqual(original);
    }
    expect(launches).toHaveLength(0);
    const before = (await service.getBoard(projectId)).tasks;
    await expect(
      service.updateTask(moving, { beforeId: "missing" }, USER)
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.getBoard(projectId)).tasks).toEqual(before);
  });
});

describe("column capacity", () => {
  it("defaults to unlimited, validates limits, and allows lowering/removing them", async () => {
    const id = await columnId("ready");
    expect(
      (await service.getBoard(projectId)).columns.find((c) => c.id === id)
    ).toMatchObject({ capacity: null, activeTaskCount: 0 });
    for (const capacity of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
      await expect(
        service.updateColumn(id, { capacity })
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.createColumn(projectId, { name: "Invalid", capacity })
      ).rejects.toMatchObject({ status: 400 });
    }
    const custom = await service.createColumn(projectId, {
      name: "Limited",
      capacity: 2147483647,
    });
    expect(custom).toMatchObject({ capacity: 2147483647, activeTaskCount: 0 });
    await service.createTask({ projectId, title: "one", columnId: id }, USER);
    await service.createTask({ projectId, title: "two", columnId: id }, USER);
    expect(await service.updateColumn(id, { capacity: 1 })).toMatchObject({
      capacity: 1,
      activeTaskCount: 2,
    });
    await expect(
      service.createTask({ projectId, title: "three", columnId: id }, USER)
    ).rejects.toMatchObject({
      code: "column_capacity_exceeded",
      extra: { count: 2, limit: 1 },
    });
    expect(await service.updateColumn(id, { capacity: null })).toMatchObject({
      capacity: null,
      activeTaskCount: 2,
    });
    await service.createTask({ projectId, title: "three", columnId: id }, USER);
  });

  it.each(["create", "move", "restore"] as const)(
    "serializes the last slot for %s across separate service instances",
    async (entry) => {
      const id = await columnId("ready");
      const tasks =
        entry === "create"
          ? []
          : await Promise.all(
              Array.from({ length: 8 }, (_, i) =>
                service.createTask(
                  {
                    projectId,
                    title: `task ${i}`,
                    ...(entry === "restore" ? { columnId: id } : {}),
                  },
                  USER
                )
              )
            );
      if (entry === "restore")
        for (const task of tasks) await service.archiveTask(task.id, USER);
      await service.updateColumn(id, { capacity: 1 });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => {
          const instance = build();
          return entry === "create"
            ? instance.createTask(
                { projectId, title: `task ${i}`, columnId: id },
                USER
              )
            : entry === "move"
              ? instance.updateTask(tasks[i]!.id, { columnId: id }, USER)
              : instance.restoreTask(tasks[i]!.id, USER);
        })
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(7);
      for (const result of failures)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            status: 409,
            code: "column_capacity_exceeded",
            extra: {
              column: { id, key: "ready", name: "Ready" },
              count: 1,
              limit: 1,
            },
          });
      expect(
        (await service.getBoard(projectId)).columns.find((c) => c.id === id)
          ?.activeTaskCount
      ).toBe(1);
    }
  );

  it.each([1, null] as const)(
    "serializes a queued limit change to %s before admission",
    async (capacity) => {
      const id = await columnId("ready");
      await service.createTask(
        { projectId, title: "occupied", columnId: id },
        USER
      );
      await service.updateColumn(id, {
        capacity: capacity === null ? 1 : null,
      });
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM task_columns WHERE id = $1 FOR NO KEY UPDATE",
        [id]
      );
      const waitForBlocked = async (count: number) => {
        await vi.waitFor(async () => {
          const result = await pool.query(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%task_columns%'"
          );
          expect(result.rows[0].n).toBeGreaterThanOrEqual(count);
        });
      };
      let updated: Promise<unknown> | undefined;
      let entrant: Promise<unknown> | undefined;
      try {
        updated = build().updateColumn(id, { capacity });
        await waitForBlocked(1);
        entrant = build()
          .createTask({ projectId, title: "entrant", columnId: id }, USER)
          .catch((error) => error);
        await waitForBlocked(2);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      await updated;
      const result = await entrant;
      if (capacity === 1)
        expect(result).toMatchObject({
          code: "column_capacity_exceeded",
          extra: { count: 1, limit: 1 },
        });
      else expect(result).toMatchObject({ title: "entrant", columnId: id });
      expect(
        (await service.getBoard(projectId)).columns.find((c) => c.id === id)
      ).toMatchObject({ capacity, activeTaskCount: capacity === 1 ? 1 : 2 });
    }
  );

  it("HTTP validates capacities and returns the stable conflict payload", async () => {
    const app = Fastify();
    await app.register(fastifyMultipart);
    await registerTaskRoutes(app, {
      taskService: service,
      withStreamFlag: (agent) => ({ ...agent, hasStream: false }),
    });
    try {
      for (const capacity of [0, -1, 1.5, "1", 2147483648, true]) {
        const result = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${projectId}/task-columns`,
          payload: { name: "Invalid", capacity },
        });
        expect(result.statusCode).toBe(400);
      }
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/task-columns`,
        payload: { name: "HTTP limited", capacity: 1 },
      });
      expect(created.statusCode).toBe(200);
      const column = created.json();
      expect(column).toMatchObject({ capacity: 1, activeTaskCount: 0 });
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: { projectId, title: "first", columnId: column.id },
      });
      expect(first.statusCode).toBe(200);
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: { projectId, title: "second", columnId: column.id },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({
        code: "column_capacity_exceeded",
        column: { id: column.id, key: column.key, name: column.name },
        count: 1,
        limit: 1,
      });
      const invalidUpdate = await app.inject({
        method: "PATCH",
        url: `/api/v1/task-columns/${column.id}`,
        payload: { capacity: 0 },
      });
      expect(invalidUpdate.statusCode).toBe(400);
      const removed = await app.inject({
        method: "PATCH",
        url: `/api/v1/task-columns/${column.id}`,
        payload: { capacity: null },
      });
      expect(removed.json()).toMatchObject({
        capacity: null,
        activeTaskCount: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("MCP exposes unfiltered counts and preserves conflict details", async () => {
    await insertAgent("agt_capacity_tool", "idle");
    const call = tools("agt_capacity_tool", projectId);
    const id = await columnId("ready");
    await service.updateColumn(id, { capacity: 1 });
    await service.createTask(
      { projectId, title: "occupied", columnId: id },
      USER
    );
    const listed = await call("task_list", { assignedToMe: true });
    expect(listed.structuredContent).toMatchObject({
      tasks: [],
      columnCapacity: expect.arrayContaining([
        expect.objectContaining({ id, capacity: 1, activeTaskCount: 1 }),
      ]),
    });
    const rejected = await call("task_create", {
      title: "refused",
      column: "ready",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      error: {
        code: "column_capacity_exceeded",
        column: { id, key: "ready", name: "Ready" },
        count: 1,
        limit: 1,
      },
    });
  });

  it("counts active tasks regardless of archived view and isolates columns/projects", async () => {
    const id = await columnId("ready");
    const archived = await service.createTask(
      { projectId, title: "archived", columnId: id },
      USER
    );
    await service.archiveTask(archived.id, USER);
    await service.updateColumn(id, { capacity: 1 });
    await service.createTask(
      { projectId, title: "active", columnId: id },
      USER
    );
    expect(
      (await service.getBoard(projectId, { archived: true })).columns.find(
        (c) => c.id === id
      )
    ).toMatchObject({ activeTaskCount: 1, capacity: 1 });
    await service.createTask({ projectId, title: "another column" }, USER);
    const other = await service.resolveColumnKey(otherProjectId, "ready");
    await service.updateColumn(other.id, { capacity: 1 });
    await service.createTask(
      {
        projectId: otherProjectId,
        title: "another project",
        columnId: other.id,
      },
      USER
    );
  });

  it("permits edits, reorders, exits, archive, and repeated restore while full", async () => {
    const id = await columnId("ready");
    const task = await service.createTask(
      { projectId, title: "one", columnId: id },
      USER
    );
    await service.updateColumn(id, { capacity: 1 });
    expect(
      await service.updateTask(
        task.id,
        { title: "edited", columnId: id, position: -10 },
        USER
      )
    ).toMatchObject({ title: "edited", position: -10 });
    await service.restoreTask(task.id, USER);
    await service.archiveTask(task.id, USER);
    await service.restoreTask(task.id, USER);
    await service.updateTask(
      task.id,
      { columnId: await columnId("backlog") },
      USER
    );
    expect(
      (await service.getBoard(projectId)).columns.find((c) => c.id === id)
        ?.activeTaskCount
    ).toBe(0);
  });

  it("rejects before edits, assignment, events, files or triggers; admitted Ready to In progress fires once", async () => {
    const ready = await columnId("ready");
    const progress = await withTrigger("in_progress", { fireOnCreate: true });
    const occupant = await service.createTask(
      { projectId, title: "occupied", columnId: progress },
      USER
    );
    const task = await service.createTask(
      { projectId, title: "queued", columnId: ready },
      USER
    );
    await service.updateColumn(progress, { capacity: 1 });
    await insertAgent("agt_capacity", "idle");
    const before = await service.getTaskDetail(task.id);
    const launchesBefore = launches.length;
    const postsBefore = posts.length;
    const publishedBefore = published.length;
    const refusal = { status: 409, code: "column_capacity_exceeded" };
    await expect(
      service.updateTask(
        task.id,
        {
          columnId: progress,
          title: "mutated",
          assignedAgentId: "agt_capacity",
          links: [{ kind: "url", url: "https://example.com", label: "link" }],
        },
        USER
      )
    ).rejects.toMatchObject(refusal);
    await expect(
      service.createTask(
        { projectId, title: "rejected", columnId: progress },
        USER,
        {
          startupFiles: [
            startupFileUpload(
              "capacity.txt",
              "capacity.txt",
              Buffer.from("file")
            ),
          ],
        }
      )
    ).rejects.toMatchObject(refusal);
    expect(await service.getTaskDetail(task.id)).toEqual(before);
    expect(launches).toHaveLength(launchesBefore);
    expect(posts).toHaveLength(postsBefore);
    expect(published).toHaveLength(publishedBefore);
    expect(
      await readdir(path.join(filesRoot, "tasks")).catch(() => [])
    ).toEqual([]);
    await service.archiveTask(occupant.id, USER);
    await Promise.all([
      build().updateTask(task.id, { columnId: progress }, USER),
      build().updateTask(task.id, { columnId: progress }, USER),
    ]);
    expect(launches).toHaveLength(launchesBefore + 1);
    expect(
      (await service.getTaskDetail(task.id)).events.filter(
        (e) => e.kind === "moved"
      )
    ).toHaveLength(1);
    expect((await service.requireTask(task.id)).assignedAgentId).toBeTruthy();
  });

  it("concurrent restores of one task consume one slot and emit one event", async () => {
    const id = await columnId("ready");
    const task = await service.createTask(
      { projectId, title: "archived", columnId: id },
      USER
    );
    await service.archiveTask(task.id, USER);
    await service.updateColumn(id, { capacity: 1 });
    await Promise.all(
      Array.from({ length: 8 }, () => build().restoreTask(task.id, USER))
    );
    expect(
      (await service.getTaskDetail(task.id)).events.filter(
        (e) => e.kind === "restored"
      )
    ).toHaveLength(1);
    expect(
      (await service.getBoard(projectId)).columns.find((c) => c.id === id)
        ?.activeTaskCount
    ).toBe(1);
  });

  it("rechecks a restore whose task was concurrently restored and moved elsewhere", async () => {
    const source = await columnId("ready");
    const destination = await columnId("in_progress");
    const task = await service.createTask(
      { projectId, title: "restore race", columnId: source },
      USER
    );
    await service.archiveTask(task.id, USER);
    await service.updateColumn(destination, { capacity: 1 });
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = TaskStore.prototype.lockColumn;
    // Pause one instance after its initial task read. All reads, locks and
    // mutations still run on real PostgreSQL; another instance wins the race.
    const spy = vi
      .spyOn(TaskStore.prototype, "lockColumn")
      .mockImplementationOnce(async function (this: TaskStore, id, db) {
        entered();
        await gate;
        return original.call(this, id, db);
      });
    const restoring = build().restoreTask(task.id, USER);
    try {
      await paused;
      await build().restoreTask(task.id, USER);
      await build().updateTask(task.id, { columnId: destination }, USER);
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await restoring).toMatchObject({
      columnId: destination,
      archivedAt: null,
    });
    expect(
      (await service.getTaskDetail(task.id)).events.filter(
        (e) => e.kind === "restored"
      )
    ).toHaveLength(1);
    expect(
      (await service.getBoard(projectId)).columns.find(
        (c) => c.id === destination
      )?.activeTaskCount
    ).toBe(1);
  });

  it.each([false, true])(
    "guards a trigger installed during paused admission (assignee changed: %s)",
    async (assignDuringAdmission) => {
      const source = await columnId("ready");
      const destination = await columnId("in_progress");
      await service.updateColumn(destination, { capacity: 1 });
      const task = await service.createTask(
        { projectId, title: "protected", columnId: source },
        USER
      );
      await insertAgent("agt_working_capacity", "running", "Working builder");
      if (!assignDuringAdmission)
        await service.updateTask(
          task.id,
          { assignedAgentId: "agt_working_capacity" },
          USER
        );
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = TaskStore.prototype.lockColumn;
      const spy = vi
        .spyOn(TaskStore.prototype, "lockColumn")
        .mockImplementationOnce(async function (this: TaskStore, id, db) {
          entered();
          await gate;
          return original.call(this, id, db);
        });
      const moving = build()
        .updateTask(
          task.id,
          { columnId: destination, title: "refused edit" },
          USER
        )
        .catch((error) => error);
      try {
        await paused;
        await build().updateColumn(destination, {
          trigger: { templateId: TEMPLATE_ID },
        });
        if (assignDuringAdmission)
          await build().updateTask(
            task.id,
            { assignedAgentId: "agt_working_capacity" },
            USER
          );
        const before = await service.getTaskDetail(task.id);
        const publishedBefore = published.length;
        const postsBefore = posts.length;
        release();
        expect(await moving).toMatchObject({
          status: 409,
          code: "agent_working",
          extra: {
            agent: { id: "agt_working_capacity", name: "Working builder" },
          },
        });
        expect(await service.getTaskDetail(task.id)).toEqual(before);
        expect(launches).toHaveLength(0);
        expect(published).toHaveLength(publishedBefore);
        expect(posts).toHaveLength(postsBefore);
        expect(
          await build().updateTask(
            task.id,
            { columnId: destination, confirmRelaunch: true },
            USER
          )
        ).toMatchObject({ columnId: destination });
        expect(launches).toHaveLength(1);
        expect(
          (await service.getTaskDetail(task.id)).events.filter(
            (event) => event.kind === "moved"
          )
        ).toHaveLength(1);
      } finally {
        release();
        spy.mockRestore();
      }
    }
  );

  it("opposing moves and completion-column updates use compatible lock order", async () => {
    const a = await columnId("ready");
    const b = await columnId("in_progress");
    await service.updateColumn(a, { capacity: 2 });
    await service.updateColumn(b, { capacity: 2 });
    const first = await service.createTask(
      { projectId, title: "a", columnId: a },
      USER
    );
    const second = await service.createTask(
      { projectId, title: "b", columnId: b },
      USER
    );
    await Promise.all([
      build().updateTask(first.id, { columnId: b }, USER),
      build().updateTask(second.id, { columnId: a }, USER),
      build().updateColumn(a, { isDone: true }),
      build().updateColumn(b, { isDone: true }),
    ]);
    const board = await service.getBoard(projectId);
    expect(board.columns.filter((c) => c.isDone)).toHaveLength(1);
    expect(board.columns.find((c) => c.id === a)?.activeTaskCount).toBe(1);
    expect(board.columns.find((c) => c.id === b)?.activeTaskCount).toBe(1);
  });

  it("completion bulk archive frees capacity and preserves completion timestamps", async () => {
    const id = await columnId("done");
    await service.updateColumn(id, { capacity: 1 });
    const task = await service.createTask(
      { projectId, title: "done", columnId: id },
      USER
    );
    expect(task.completedAt).toBeTruthy();
    await service.archiveColumn(projectId, id, USER);
    const next = await service.createTask(
      { projectId, title: "next", columnId: id },
      USER
    );
    await expect(service.restoreTask(task.id, USER)).rejects.toMatchObject({
      code: "column_capacity_exceeded",
    });
    expect((await service.requireTask(task.id)).completedAt).toBe(
      task.completedAt
    );
    await service.archiveTask(next.id, USER);
    expect((await service.restoreTask(task.id, USER)).completedAt).toBe(
      task.completedAt
    );
  });
});

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
      "trigger_launching",
      "trigger_launched",
      "updated",
    ]);
    expect(detail.assignedAgentId).toBeNull();
  });

  it.each(["trigger", "manual"])(
    "uses a short task name for a %s launch",
    async (mode) => {
      const ready = await withTrigger("ready");
      const task = await service.createTask(
        { projectId, title: "Implement task agent names across launch paths" },
        USER
      );
      if (mode === "trigger")
        await service.updateTask(task.id, { columnId: ready }, USER);
      else
        await service.launchAgent(task.id, { templateId: TEMPLATE_ID }, USER);
      expect(launches[0]!.name).toBe(
        "Implement task agent names across launch…"
      );
      expect(launches[0]!.appendix).toContain(
        "As your first act, please call the `rename_session` MCP tool"
      );
    }
  );

  it("launches a prompt-less persona template with the briefing as its prompt", async () => {
    const prompted: Array<string | undefined> = [];
    const promptless = template({
      id: TEMPLATE_ID,
      prompt: null,
      persona: "builder",
    });
    const templates = new TemplateService(
      {} as never,
      {
        createAgent: async (input: { initialPrompt?: string }) => {
          prompted.push(input.initialPrompt);
          const id = `agt_launch_${++agentSeq}`;
          await insertAgent(id, "running", "Builder");
          return { id } as AgentRecord;
        },
      } as never,
      { info: vi.fn() } as never
    );
    vi.spyOn(templates.store, "getTemplate").mockResolvedValue(promptless);
    service = build(filesRoot, {
      getTemplate: async (id) => (id === TEMPLATE_ID ? promptless : null),
      launchTemplate: async (input) =>
        (await templates.launchTemplate(input)).agent,
    });
    const ready = await withTrigger("ready", { assign: false });
    const task = await service.createTask(
      { projectId, title: "Ship it", body: "Acceptance: it ships." },
      USER
    );
    await service.updateTask(task.id, { columnId: ready }, USER);
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toMatch(/^## Dispatch task/);
    expect(prompted[0]).toContain(task.id);
    expect(prompted[0]).toContain("Acceptance: it ships.");
    const detail = await service.getTaskDetail(task.id);
    expect(detail.events.map((e) => e.kind)).not.toContain("trigger_failed");

    // A manual launch takes the same path.
    await service.launchAgent(task.id, { templateId: TEMPLATE_ID }, USER);
    expect(prompted).toHaveLength(2);
    expect(prompted[1]).toMatch(/^## Dispatch task/);
    expect(prompted[1]).toContain(task.id);
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
    expect(task.launching).toBeNull();
    expect(
      (await service.getTaskDetail(task.id)).events.map((e) => e.kind)
    ).toEqual(
      expect.arrayContaining([
        "created",
        "trigger_launching",
        "trigger_launched",
      ])
    );
  });

  it("shows a launch while it runs and clears it on success", async () => {
    const ready = await withTrigger("ready");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    let release!: () => void;
    launchGate = new Promise((resolve) => (release = resolve));
    const moving = service.updateTask(task.id, { columnId: ready }, USER);
    await vi.waitFor(async () => {
      expect(launches).toHaveLength(1);
    });
    const during = await service.getTaskDetail(task.id);
    expect(during.launching).toMatchObject({ templateId: TEMPLATE_ID });
    expect(during.latestFailure).toBeNull();
    expect(
      (await service.getBoard(projectId)).tasks.find((t) => t.id === task.id)
        ?.launching
    ).toMatchObject({ templateId: TEMPLATE_ID });
    expect(published.filter((event) => event.taskId === task.id)).toHaveLength(
      2
    );
    release();
    expect((await moving).launching).toBeNull();
  });

  it("publishes launch progress for a task created in a trigger column", async () => {
    const ready = await withTrigger("ready", { fireOnCreate: true });
    let release!: () => void;
    launchGate = new Promise((resolve) => (release = resolve));
    const creating = service.createTask(
      { projectId, title: "new", columnId: ready },
      USER
    );
    await vi.waitFor(async () => {
      expect(launches).toHaveLength(1);
    });
    const during = (await service.getBoard(projectId)).tasks.find(
      (task) => task.title === "new"
    );
    expect(during?.launching).toMatchObject({ templateId: TEMPLATE_ID });
    release();
    expect((await creating).launching).toBeNull();
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
    expect(detail.launching).toBeNull();
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
    expect((await service.requireTask(task.id)).latestFailure).toBeNull();
    const again = await service.updateTask(task.id, { columnId: ready }, USER);
    expect(again.latestFailure).toBeNull();
  });

  it("shows only a new failure after re-entry", async () => {
    const ready = await withTrigger("ready");
    const backlog = await columnId("backlog");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    launchFails = "first failure";
    await service.updateTask(task.id, { columnId: ready }, USER);
    expect((await service.requireTask(task.id)).latestFailure?.reason).toBe(
      "first failure"
    );
    await service.updateTask(task.id, { columnId: backlog }, USER);
    expect((await service.requireTask(task.id)).latestFailure).toBeNull();
    launchFails = "second failure";
    let release!: () => void;
    launchGate = new Promise((resolve) => (release = resolve));
    const moving = service.updateTask(task.id, { columnId: ready }, USER);
    await vi.waitFor(async () => {
      expect(launches).toHaveLength(2);
    });
    const during = await service.requireTask(task.id);
    expect(during.latestFailure).toBeNull();
    expect(during.launching).toMatchObject({ templateId: TEMPLATE_ID });
    release();
    const again = await moving;
    expect(again.latestFailure?.reason).toBe("second failure");
    expect(again.launching).toBeNull();
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
    expect(
      (await service.getTaskDetail(task.id)).events.filter(
        (e) => e.kind === "trigger_launching"
      )
    ).toHaveLength(1);

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
  it("posts manual assignment and reassignment into the task's stream", async () => {
    await insertAgent("agt_a");
    await insertAgent("agt_b");
    // The title names another agent: the block must still go to the assignee.
    const task = await service.createTask(
      { projectId, title: "Ship it with @Reviewer" },
      USER
    );
    await service.updateTask(task.id, { assignedAgentId: "agt_a" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_b" }, USER);
    const detail = await service.getTaskDetail(task.id);
    const agentId = detail.assignedAgentId!;
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({
      streamId: task.id,
      input: {
        to: agentId,
        text: `You're assigned to task ${task.id} — Ship it with @Reviewer. This stream is the task's conversation; reply here.`,
        allowInert: true,
        resolveMentions: false,
      },
    });
    expect(detail.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agt_a",
          role: "manual",
          columnId: null,
        }),
        expect.objectContaining({ agentId, role: "manual", columnId: null }),
      ])
    );
    expect(detail.agents[0]).not.toHaveProperty("conversation");
    expect(posts[0]!.input.to).toBe("agt_a");
    expect(launches).toHaveLength(0);
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
      "task_watch",
      "task_unwatch",
      "task_board_watch",
      "task_board_unwatch",
      "task_create",
      "task_update",
      "task_column_update",
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
  it("lists ordered column configuration without changing existing task rows", async () => {
    const ready = await columnId("ready");
    const progress = await withTrigger("in_progress");
    const review = await withTrigger("in_review", {
      agentType: "claude",
      model: "sonnet",
      assign: false,
      fireOnCreate: true,
    });
    for (const [id, capacity] of [
      [ready, 2],
      [progress, 2],
      [review, 4],
    ] as const) {
      await service.updateColumn(id, { capacity });
    }
    const task = await service.createTask(
      { projectId, title: "Queued", columnId: ready },
      USER
    );
    const expectedColumns = (await service.getBoard(projectId)).columns;
    const result = await tools("agt_reader", projectId)("task_list", {});
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent!;
    expect(data.columns).toEqual(expectedColumns.map((c) => c.key));
    expect(data.columnCapacity).toEqual(
      expectedColumns.map((c) => ({
        id: c.id,
        key: c.key,
        name: c.name,
        position: c.position,
        capacity: c.capacity,
        activeTaskCount: c.activeTaskCount,
        isDone: c.isDone,
        trigger: c.trigger,
      }))
    );
    expect(data.columnCapacity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ready",
          capacity: 2,
          trigger: null,
          isDone: false,
        }),
        expect.objectContaining({
          key: "in_progress",
          capacity: 2,
          trigger: {
            templateId: TEMPLATE_ID,
            templateName: "Builder",
            agentType: null,
            model: null,
            assign: true,
            fireOnCreate: false,
          },
        }),
        expect.objectContaining({
          key: "in_review",
          capacity: 4,
          trigger: {
            templateId: TEMPLATE_ID,
            templateName: "Builder",
            agentType: "claude",
            model: "sonnet",
            assign: false,
            fireOnCreate: true,
          },
        }),
        expect.objectContaining({
          key: "done",
          capacity: null,
          trigger: null,
          isDone: true,
        }),
      ])
    );
    expect(data.tasks).toEqual([
      {
        id: task.id,
        title: task.title,
        column: "ready",
        assignedAgentId: null,
        updatedAt: task.updatedAt,
      },
    ]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(data);
    expect(launches).toHaveLength(0);
  });

  it("keeps column metadata and global active counts across filtered MCP reads", async () => {
    await insertAgent("agt_reader", "idle");
    const ready = await columnId("ready");
    const progress = await withTrigger("in_progress");
    await service.updateColumn(ready, { capacity: 2 });
    await service.updateColumn(progress, { capacity: 2 });
    const active = await service.createTask(
      { projectId, title: "Active", columnId: ready },
      USER
    );
    const archived = await service.createTask(
      { projectId, title: "Archived", columnId: ready },
      USER
    );
    await service.archiveTask(archived.id, USER);
    const call = tools("agt_reader", projectId);
    const all = (await call("task_list", {})).structuredContent!;
    for (const filter of [
      { column: "in_progress" },
      { assignedToMe: true },
      { archived: true },
      { archived: true, column: "in_progress", assignedToMe: true },
    ]) {
      const filtered = (await call("task_list", filter)).structuredContent!;
      expect(filtered.columns).toEqual(all.columns);
      expect(filtered.columnCapacity).toEqual(all.columnCapacity);
      expect(filtered.tasks).toEqual(
        filter.archived && !filter.column
          ? [expect.objectContaining({ id: archived.id })]
          : []
      );
    }
    expect(all.tasks).toEqual([expect.objectContaining({ id: active.id })]);
    expect(all.columnCapacity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ready",
          capacity: 2,
          activeTaskCount: 1,
          trigger: null,
        }),
        expect.objectContaining({
          key: "in_progress",
          capacity: 2,
          activeTaskCount: 0,
          trigger: expect.objectContaining({ templateId: TEMPLATE_ID }),
        }),
      ])
    );
    expect(launches).toHaveLength(0);
  });

  it("round-trips trigger replacement, omission, inheritance and removal without changing tasks", async () => {
    const ready = await columnId("ready");
    await service.updateColumn(ready, {
      name: "Queue",
      position: 17,
      capacity: 3,
      isDone: true,
    });
    const task = await service.createTask(
      { projectId, columnId: ready, title: "Existing" },
      USER
    );
    const before = await service.requireColumn(ready);
    const call = tools("agt_config", projectId, { fullAccess: false });
    const configured = await call("task_column_update", {
      column: "ready",
      trigger: {
        templateId: TEMPLATE_ID,
        agentType: "claude",
        model: "sonnet",
        assign: false,
        fireOnCreate: true,
      },
    });
    expect(configured.isError).toBeUndefined();
    expect(configured.structuredContent).toEqual({
      projectId,
      id: ready,
      key: "ready",
      name: "Queue",
      position: 17,
      capacity: 3,
      activeTaskCount: 1,
      isDone: true,
      trigger: {
        templateId: TEMPLATE_ID,
        templateName: "Builder",
        agentType: "claude",
        model: "sonnet",
        assign: false,
        fireOnCreate: true,
      },
    });
    expect(JSON.parse(configured.content[0]!.text)).toEqual(
      configured.structuredContent
    );
    const preserved = await call("task_column_update", { column: "ready" });
    expect(preserved.structuredContent).toEqual(configured.structuredContent);
    const replaced = await call("task_column_update", {
      column: "ready",
      trigger: { templateId: TEMPLATE_ID },
    });
    expect(replaced.structuredContent!.trigger).toEqual({
      templateId: TEMPLATE_ID,
      templateName: "Builder",
      agentType: null,
      model: null,
      assign: true,
      fireOnCreate: false,
    });
    const inherited = await call("task_column_update", {
      column: "ready",
      trigger: { templateId: TEMPLATE_ID, agentType: null, model: null },
    });
    expect(inherited.structuredContent).toEqual(replaced.structuredContent);
    expect(
      (await call("task_list", {})).structuredContent!.columnCapacity
    ).toContainEqual(
      Object.fromEntries(
        Object.entries(replaced.structuredContent!).filter(
          ([key]) => key !== "projectId"
        )
      )
    );
    const removed = await call("task_column_update", {
      column: "ready",
      trigger: null,
    });
    expect(removed.structuredContent).toEqual({
      ...configured.structuredContent,
      trigger: null,
    });
    const after = await service.requireColumn(ready);
    expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
    expect(await service.requireTask(task.id)).toEqual(task);
    expect(launches).toHaveLength(0);
  });

  it("keeps configured create/move launch settings and template inheritance", async () => {
    await insertAgent("agt_config");
    const call = tools("agt_config", projectId);
    await call("task_column_update", {
      column: "ready",
      trigger: {
        templateId: TEMPLATE_ID,
        agentType: "codex",
        model: "gpt-5.5",
        assign: false,
        fireOnCreate: false,
      },
    });
    const created = await call("task_create", {
      title: "Created directly",
      column: "ready",
    });
    expect(launches).toHaveLength(0);
    const waiting = await call("task_create", { title: "Waiting" });
    const moved = await call("task_update", {
      id: waiting.structuredContent!.id,
      column: "ready",
    });
    expect(moved.isError).toBeUndefined();
    expect(moved.structuredContent!.assignedAgentId).toBeNull();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      templateId: TEMPLATE_ID,
      agentType: "codex",
      model: "gpt-5.5",
    });
    expect(
      (await call("task_get", { id: created.structuredContent!.id }))
        .structuredContent!.assignedAgentId
    ).toBeNull();
    await call("task_column_update", {
      column: "ready",
      trigger: {
        templateId: TEMPLATE_ID,
        agentType: null,
        model: null,
        fireOnCreate: true,
      },
    });
    expect(launches).toHaveLength(1);
    const inherited = await call("task_create", {
      title: "Inherited",
      column: "ready",
    });
    const detail = await service.getTaskDetail(
      inherited.structuredContent!.id as string
    );
    expect(detail.assignedAgentId).not.toBeNull();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({ templateId: TEMPLATE_ID });
    // No overrides are forwarded, so the template launcher uses its settings.
    expect(launches[1]).not.toHaveProperty("agentType");
    expect(launches[1]).not.toHaveProperty("model");
    const opencode = await call("task_column_update", {
      column: "ready",
      trigger: { templateId: TEMPLATE_ID, agentType: "opencode", model: null },
    });
    expect(opencode.structuredContent!.trigger).toMatchObject({
      agentType: "opencode",
      model: null,
    });
    expect(launches).toHaveLength(2);
  });

  it("reads and removes a deleted-template trigger without revalidating it", async () => {
    await withTrigger("ready");
    service = build(filesRoot, { getTemplate: async () => null });
    const call = tools("agt_config", projectId);
    const preserved = await call("task_column_update", { column: "ready" });
    expect(preserved.isError).toBeUndefined();
    expect(preserved.structuredContent!.trigger).toMatchObject({
      templateId: TEMPLATE_ID,
      templateName: null,
    });
    expect(
      (await call("task_list", {})).structuredContent!.columnCapacity
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ready",
          trigger: preserved.structuredContent!.trigger,
        }),
      ])
    );
    expect(
      (await call("task_column_update", { column: "ready", trigger: null }))
        .structuredContent!.trigger
    ).toBeNull();
    expect(launches).toHaveLength(0);
  });

  it("rejects invalid trigger replacements before any write", async () => {
    const ready = await withTrigger("ready");
    const before = await service.requireColumn(ready);
    const call = tools("agt_config", projectId);
    const eventCount = published.length;
    for (const trigger of [
      { templateId: "missing" },
      { templateId: OTHER_TEMPLATE_ID },
      { templateId: TEMPLATE_ID, agentType: "invalid" },
      { templateId: TEMPLATE_ID, agentType: "claude", model: "invalid-model" },
    ]) {
      const result = await call("task_column_update", {
        column: "ready",
        trigger,
      });
      expect(result.isError, JSON.stringify(trigger)).toBe(true);
      expect(await service.requireColumn(ready)).toEqual(before);
    }
    expect(published).toHaveLength(eventCount);
    expect(launches).toHaveLength(0);
  });

  it("scopes column keys to the caller board and never treats IDs as authority", async () => {
    const own = await columnId("ready");
    const foreign = await service.resolveColumnKey(otherProjectId, "ready");
    const call = tools("agt_config", projectId);
    for (const args of [
      { projectId: otherProjectId, column: "ready" },
      { column: foreign.id },
      { column: own },
      { column: "unknown" },
    ])
      expect(
        (
          await call("task_column_update", {
            ...args,
            trigger: { templateId: TEMPLATE_ID },
          })
        ).isError
      ).toBe(true);
    expect(
      (
        await tools("agt_lost", null)("task_column_update", {
          column: "ready",
          trigger: null,
        })
      ).isError
    ).toBe(true);
    const fallback = tools("agt_projectless", null, { paths: [REPO] });
    expect(
      (await fallback("task_column_update", { column: "ready", trigger: null }))
        .structuredContent!.projectId
    ).toBe(projectId);
    expect((await service.requireColumn(own)).trigger).toBeNull();
    expect((await service.requireColumn(foreign.id)).trigger).toBeNull();
    expect(launches).toHaveLength(0);
  });

  it("configuration preserves the restricted caller ceiling on subsequent launches", async () => {
    await insertAgent("agt_restricted");
    const call = tools("agt_restricted", projectId, { fullAccess: false });
    expect(
      (
        await call("task_column_update", {
          column: "ready",
          trigger: { templateId: FULL_TEMPLATE_ID, fireOnCreate: true },
        })
      ).isError
    ).toBeUndefined();
    expect(launches).toHaveLength(0);
    const created = await call("task_create", {
      title: "Restricted",
      column: "ready",
    });
    expect(created.isError).toBeUndefined();
    expect(launches).toHaveLength(0);
    const detail = await service.getTaskDetail(
      created.structuredContent!.id as string
    );
    expect(detail.latestFailure?.reason).toMatch(/restricted agent/);
  });

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

  it("task_comment posts in the task's stream for any agent in its project", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask({ projectId, title: "t" }, USER);
    const other = await call("task_comment", { id: task.id, text: "hi" });
    expect(other.isError).toBeUndefined();
    expect((await service.getTaskDetail(task.id)).agents).toEqual([]);
    agentPosts.length = 0;

    // From another project it is refused, without the old assign hint.
    const outsider = await tools("agt_tool", otherProjectId)("task_comment", {
      id: task.id,
      text: "hi",
    });
    expect(outsider.isError).toBe(true);
    expect(outsider.content[0]!.text).toBe(
      `You are not in task ${task.id}'s project; only agents in its project post in its conversation.`
    );
    expect(outsider.content[0]!.text).not.toMatch(/assign/);
    expect(agentPosts).toEqual([]);

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

  it("task_update archives and restores only when archived is sent alone", async () => {
    await insertAgent("agt_tool");
    await insertAgent("agt_busy");
    const task = await service.createTask({ projectId, title: "t" }, USER);
    await service.updateTask(task.id, { assignedAgentId: "agt_busy" }, USER);
    await service.archiveTask(task.id, USER);
    const call = tools("agt_tool", projectId);

    const combined = await call("task_update", {
      id: task.id,
      archived: false,
      assign: "self",
    });
    expect(combined.isError).toBe(true);
    const unchanged = await service.getTaskDetail(task.id);
    expect(unchanged.archivedAt).not.toBeNull();
    expect(unchanged.assignedAgentId).toBe("agt_busy");
    expect(unchanged.events.some((e) => e.kind === "restored")).toBe(false);

    const restored = await call("task_update", {
      id: task.id,
      archived: false,
    });
    expect(restored.isError).toBeFalsy();
    expect((await service.requireTask(task.id)).archivedAt).toBeNull();
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

  it("watches idempotently without changing assignment, column or history", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    const task = await service.createTask(
      { projectId, title: "Watch me" },
      USER
    );
    const before = await service.getTaskDetail(task.id);
    expect(
      (await call("task_watch", { id: task.id })).structuredContent
    ).toEqual({ id: task.id, watching: true });
    const createdAt = (
      await pool.query(
        `SELECT created_at::text AS created_at FROM task_watches`
      )
    ).rows[0].created_at;
    await call("task_watch", { id: task.id });
    expect(
      (
        await pool.query(
          `SELECT created_at::text AS created_at FROM task_watches`
        )
      ).rows
    ).toEqual([{ created_at: createdAt }]);
    expect(await service.getTaskDetail(task.id)).toEqual(before);
    expect(
      (await call("task_get", { id: task.id })).structuredContent!.watching
    ).toBe(true);
    expect(await build().watching(task.id, "agt_tool")).toBe(true);
    await call("task_unwatch", { id: task.id });
    expect(await service.watching(task.id, "agt_tool")).toBe(false);
    await pool.query(
      `UPDATE agents SET deleted_at = now() WHERE id = 'agt_tool'`
    );
    expect((await call("task_watch", { id: task.id })).isError).toBe(true);
  });

  it("keeps board subscriptions durable, idempotent, independent and scoped to a real caller", async () => {
    await insertAgent("agt_tool");
    const call = tools("agt_tool", projectId);
    expect((await call("task_list", {})).structuredContent!.boardWatching).toBe(
      false
    );
    expect((await call("task_board_watch", {})).structuredContent).toEqual({
      projectId,
      watching: true,
    });
    const first = (
      await pool.query(`SELECT id, created_at FROM task_board_watches`)
    ).rows;
    await call("task_board_watch", { projectId });
    expect(
      (await pool.query(`SELECT id, created_at FROM task_board_watches`)).rows
    ).toEqual(first);
    expect((await call("task_list", {})).structuredContent!.boardWatching).toBe(
      true
    );
    expect(await build().boardWatching(projectId, "agt_tool")).toBe(true);
    const task = await service.createTask({ projectId, title: "Future" }, USER);
    expect(
      (await call("task_get", { id: task.id })).structuredContent!.watching
    ).toBe(false);
    await call("task_watch", { id: task.id });
    await call("task_board_unwatch", {});
    expect(await service.watching(task.id, "agt_tool")).toBe(true);
    await call("task_board_watch", {});
    await call("task_unwatch", { id: task.id });
    expect(await service.boardWatching(projectId, "agt_tool")).toBe(true);
    expect(
      (await call("task_board_watch", { projectId: otherProjectId })).isError
    ).toBe(true);
    await expect(
      service.watchBoard(otherProjectId, "agt_tool")
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.watchBoard(projectId, "unknown")
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await tools("agt_tool", null)("task_board_watch", {})).isError
    ).toBe(true);
    await pool.query(
      `UPDATE agents SET deleted_at = now() WHERE id = 'agt_tool'`
    );
    expect((await call("task_board_watch", {})).isError).toBe(true);
    expect((await call("task_board_unwatch", {})).isError).toBe(true);
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

  // Hold an actual initial database read to exercise slow CI scheduling
  // deterministically, while leaving later observations of persisted state free.
  function holdInitialRead() {
    let entered!: () => void;
    let open!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (open = resolve));
    const getTask = service.store.getTask.bind(service.store);
    const spy = vi
      .spyOn(service.store, "getTask")
      .mockImplementationOnce(async (...args) => {
        entered();
        await released;
        return getTask(...args);
      });
    return { entered: started, open, restore: () => spy.mockRestore() };
  }

  it.each([false, true])(
    "serializes a newer move behind a slow launch (held initial read: %s)",
    async (holdRead) => {
      const ready = await withTrigger("ready");
      const backlog = await columnId("backlog");
      const task = await service.createTask({ projectId, title: "t" }, USER);
      let open!: () => void;
      launchGate = new Promise((resolve) => (open = resolve));
      const entered = new Promise<void>((resolve) => (launchEntered = resolve));
      const initialRead = holdRead ? holdInitialRead() : null;
      const first = service.updateTask(task.id, { columnId: ready }, USER);
      const second = service.updateTask(
        task.id,
        { columnId: backlog, confirmRelaunch: true },
        USER
      );
      // Observe rejection immediately even if a setup/assertion fails first.
      const settled = Promise.allSettled([first, second]);
      try {
        if (initialRead) {
          await initialRead.entered;
          expect((await service.requireTask(task.id)).columnId).toBe(backlog);
          expect(launches).toHaveLength(0);
          initialRead.open();
        }
        await Promise.race([entered, first]);
        expect(launches).toHaveLength(1);
        // The newer move is waiting on the entered launch, not racing it.
        expect((await service.requireTask(task.id)).columnId).toBe(ready);
        open();
        await Promise.all([first, second]);
        const final = await service.requireTask(task.id);
        expect(final.columnId).toBe(backlog);
        const kinds = (await service.getTaskDetail(task.id)).events.map(
          (e) => e.kind
        );
        expect(kinds.slice(-2)).toEqual(["assigned", "moved"]);
      } finally {
        initialRead?.open();
        open();
        await settled;
        initialRead?.restore();
      }
    }
  );

  it.each([false, true])(
    "a launch that finds the task moved away does not assign (held initial read: %s)",
    async (holdRead) => {
      await withTrigger("ready");
      const ready = await columnId("ready");
      const backlog = await columnId("backlog");
      const task = await service.createTask({ projectId, title: "t" }, USER);
      let open!: () => void;
      launchGate = new Promise((resolve) => (open = resolve));
      const entered = new Promise<void>((resolve) => (launchEntered = resolve));
      const initialRead = holdRead ? holdInitialRead() : null;
      const move = service.updateTask(task.id, { columnId: ready }, USER);
      const settled = Promise.allSettled([move]);
      try {
        if (initialRead) {
          await initialRead.entered;
          expect((await service.requireTask(task.id)).columnId).toBe(backlog);
          expect(launches).toHaveLength(0);
          initialRead.open();
        }
        await Promise.race([entered, move]);
        expect((await service.requireTask(task.id)).columnId).toBe(ready);
        // A write from outside this process's lock moves it on mid-launch.
        await pool.query("UPDATE tasks SET column_id = $2 WHERE id = $1", [
          task.id,
          backlog,
        ]);
        open();
        const after = await move;
        expect(launches).toHaveLength(1);
        expect(after.columnId).toBe(backlog);
        expect(after.assignedAgentId).toBeNull();
        expect((await service.requireTask(task.id)).assignedAgentId).toBeNull();
        expect(posts).toHaveLength(0);
        const kinds = (await service.getTaskDetail(task.id)).events.map(
          (e) => e.kind
        );
        expect(kinds).toContain("trigger_launched");
        expect(kinds).not.toContain("assigned");
      } finally {
        initialRead?.open();
        open();
        await settled;
        initialRead?.restore();
      }
    }
  );

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
      ["task_watch", { id: theirs.id }],
      ["task_unwatch", { id: theirs.id }],
      ["task_update", { id: theirs.id, title: "mine now" }],
    ];
    for (const [name, args] of cases) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text, name).toMatch(/own project/);
    }
    const comment = await call("task_comment", { id: theirs.id, text: "hi" });
    expect(comment.isError).toBe(true);
    expect(comment.content[0]!.text).toMatch(/not in task .*'s project/);
    expect((await service.requireTask(theirs.id)).title).toBe("theirs");
  });

  it("places a moved projectless agent where its task tools do, by the workspace's repo", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scope-")));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    const repo = async (dir: string) => {
      await mkdir(dir, { recursive: true });
      git(dir, "init", "-q");
      git(
        dir,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init"
      );
    };
    const a = path.join(root, "a");
    const b = path.join(root, "longer-b");
    await repo(a);
    await repo(b);
    const ids: Record<string, string> = {};
    for (const [name, repoRoot] of [
      ["A", a],
      ["B", b],
    ] as const) {
      ids[name] = (
        await pool.query(
          `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), $1, $2, '#336699') RETURNING id`,
          [name, repoRoot]
        )
      ).rows[0].id;
    }
    const chat = (agent: Parameters<typeof agentTaskProject>[0]) =>
      agentTaskProject(agent, (input) => service.projectForAgent(input));
    // What routes/mcp.ts hands the task tools: cwd is the workspace, and
    // repoRoot is probed from it.
    const mcp = async (agent: { workspacePath: string; cwd: string }) => {
      const workspaceDir = agent.workspacePath ?? agent.cwd;
      return service.projectForAgent(
        taskScopeInput(null, workspaceDir, await resolveRepoRoot(workspaceDir))
      );
    };
    const base = {
      projectId: null,
      cwd: path.join(root, "elsewhere"),
      worktreePath: null,
      baseBranch: null,
    };
    try {
      // A worktree of A that lives under B's directory.
      const nested = path.join(b, "worktrees", "a");
      git(a, "worktree", "add", "-q", nested);
      const inNested = { ...base, workspacePath: nested };
      await expect(chat(inNested)).resolves.toBe(await mcp(inNested));
      // Moved to an external worktree of B, it is B for both, whatever
      // stale git context it still carries for A.
      const outside = path.join(root, "outside-b");
      git(b, "worktree", "add", "-q", outside);
      const moved = {
        ...base,
        workspacePath: outside,
        gitContext: { worktreePath: a, isWorktree: false },
      };
      await expect(chat(moved)).resolves.toBe(ids.B);
      await expect(mcp(moved)).resolves.toBe(ids.B);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    expect(briefing.name).toBe("Wire it");
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

describe("task archive", () => {
  it("archives and restores idempotently, preserving task context and completion history", async () => {
    const done = await columnId("done");
    await insertAgent("agt_archive", "stopped");
    const task = await service.createTask(
      { projectId, columnId: done, title: "Keep context" },
      USER,
      {
        startupFiles: [
          startupFileUpload("archive.md", "archive.md", Buffer.from("context")),
        ],
        startupLinks: ["https://example.com/archive"],
      }
    );
    await service.updateTask(task.id, { assignedAgentId: "agt_archive" }, USER);
    const before = await service.getTaskDetail(task.id);
    published = [];
    const archived = await service.archiveTask(task.id, USER);
    expect(archived.archivedAt).toBeTruthy();
    expect((await service.archiveTask(task.id, USER)).archivedAt).toBe(
      archived.archivedAt
    );
    expect(published).toHaveLength(1);
    expect((await service.getBoard(projectId)).tasks).toEqual([]);
    expect(await service.listTasks({ projectId })).toEqual([]);
    expect(
      (await service.getBoard(projectId, { archived: true })).tasks.map(
        (t) => t.id
      )
    ).toEqual([task.id]);
    expect(
      (await service.listTasks({ projectId, archived: true })).map((t) => t.id)
    ).toEqual([task.id]);
    expect(await service.listTasks({ assignedAgentId: "agt_archive" })).toEqual(
      []
    );
    await expect(
      service.updateTask(task.id, { columnId: await columnId("backlog") }, USER)
    ).rejects.toMatchObject({ status: 409, code: "task_archived" });
    await service.updateTask(task.id, { title: "Edited while archived" }, USER);
    await service.restoreTask(task.id, USER);
    await service.restoreTask(task.id, USER);
    const after = await service.getTaskDetail(task.id);
    expect(after.archivedAt).toBeNull();
    for (const key of [
      "columnId",
      "completedAt",
      "assignedAgentId",
      "links",
      "agents",
      "attachments",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    expect(after.events.filter((e) => e.kind === "archived")).toHaveLength(1);
    expect(after.events.filter((e) => e.kind === "restored")).toHaveLength(1);
    expect((await service.getBoard(projectId)).tasks.map((t) => t.id)).toEqual([
      task.id,
    ]);
    expect(launches).toHaveLength(0);
  });

  it("restores in a trigger column without launching an agent", async () => {
    const ready = await withTrigger("ready");
    const task = await service.createTask(
      { projectId, columnId: ready, title: "No launch" },
      USER
    );
    await service.archiveTask(task.id, USER);
    await service.restoreTask(task.id, USER);
    expect(launches).toEqual([]);
    expect((await service.requireTask(task.id)).columnId).toBe(ready);
  });

  it("archives only active tasks in the project's done column, emits events, and publishes once", async () => {
    const done = await columnId("done");
    const backlog = await columnId("backlog");
    const otherDone = (await service.getBoard(otherProjectId)).columns.find(
      (c) => c.isDone
    )!.id;
    const a = await service.createTask(
      { projectId, columnId: done, title: "a" },
      USER
    );
    const b = await service.createTask(
      { projectId, columnId: done, title: "b" },
      USER
    );
    const already = await service.createTask(
      { projectId, columnId: done, title: "already" },
      USER
    );
    const active = await service.createTask(
      { projectId, columnId: backlog, title: "active" },
      USER
    );
    const other = await service.createTask(
      { projectId: otherProjectId, columnId: otherDone, title: "other" },
      USER
    );
    await service.archiveTask(already.id, USER);
    published = [];
    await expect(
      service.archiveColumn(projectId, backlog, USER)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.archiveColumn(projectId, otherDone, USER)
    ).rejects.toMatchObject({ status: 400 });
    const result = await service.archiveColumn(projectId, done, USER);
    expect(result.archived).toBe(2);
    expect(result.taskIds.sort()).toEqual([a.id, b.id].sort());
    expect(published).toHaveLength(1);
    expect((await service.archiveColumn(projectId, done, USER)).archived).toBe(
      0
    );
    expect(published).toHaveLength(1);
    expect((await service.requireTask(active.id)).archivedAt).toBeNull();
    expect((await service.requireTask(other.id)).archivedAt).toBeNull();
    for (const id of [a.id, b.id]) {
      expect((await service.getTaskDetail(id)).events.at(-1)).toMatchObject({
        kind: "archived",
        data: { bulk: true, columnId: done },
      });
    }
    expect(
      (await service.getTaskDetail(already.id)).events.filter(
        (e) => e.kind === "archived"
      )
    ).toHaveLength(1);
  });
});
