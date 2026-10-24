import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { StreamService, type StreamAgent } from "../src/chat/service.js";
import { registerStreamRoutes } from "../src/routes/streams.js";
import { handleAgentError } from "../src/server/http-helpers.js";
import { TaskService } from "../src/tasks/service.js";
import type { Task } from "../src/tasks/types.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

// A task is a stream root: its conversation is the blocks whose stream_id
// is the task's id, delivered to the task's agents.

let pool: Pool;
let streams: StreamService;
let tasks: TaskService;
let app: FastifyInstance;
let prompts: Array<{ agentId: string; text: string }>;
/** When set, prompts wait in `waiting` (behind a turn) instead of reaching the engine. */
let holding: boolean;
let waiting: Array<{
  agentId: string;
  blockId?: string;
  release: () => void;
  reject: (error: Error) => void;
}>;
let projectId: string;

const ASSIGNEE = "agt_task_owner";
const HELPER = "agt_task_helper";
const STRANGER = "agt_task_stranger";
const AGENTS: Record<string, StreamAgent> = {
  [ASSIGNEE]: {
    id: ASSIGNEE,
    name: "Owner",
    filesDir: null,
    status: "running",
  },
  [HELPER]: { id: HELPER, name: "Helper", filesDir: null, status: "running" },
  [STRANGER]: {
    id: STRANGER,
    name: "Stranger",
    filesDir: null,
    status: "running",
  },
};
const USER = { kind: "user" } as const;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM task_columns");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM projects");
  for (const agent of Object.values(AGENTS)) {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ($1, $2, '/tmp', 'running')`,
      [agent.id, agent.name]
    );
  }
  projectId = (
    await pool.query(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Tasks', '/repo/tasks', '#336699') RETURNING id`
    )
  ).rows[0].id;
  prompts = [];
  holding = false;
  waiting = [];
  streams = new StreamService({
    pool,
    publishUiEvent: () => {},
    getAgent: async (id) => AGENTS[id] ?? null,
    filesRoot: "/files-root",
    delivery: {
      access: async () => ({ mode: "live" as const }),
      inject: (agentId, text, opts) => {
        if (!holding) {
          prompts.push({ agentId, text });
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) =>
          waiting.push({
            agentId,
            ...(opts?.blockId ? { blockId: opts.blockId } : {}),
            release: () => {
              prompts.push({ agentId, text });
              resolve();
            },
            reject,
          })
        );
      },
      held: () => waiting.length > 0,
      activeTurn: () => waiting.length > 0,
      // The runtime's claim: an unsent prompt is taken out of the queue.
      controlQueuedPrompt: (ids, blockId, action) => {
        const index = waiting.findIndex(
          (w) => ids.includes(w.agentId) && w.blockId === blockId
        );
        if (index < 0 || action !== "delete") return false;
        const [prompt] = waiting.splice(index, 1);
        const error = new Error("Queued message deleted.");
        error.name = "QueuedPromptDeletedError";
        prompt!.reject(error);
        return true;
      },
      cancel: async () => {},
    },
    taskRoot: (id) => tasks.streamRoot(id),
  });
  tasks = new TaskService({
    pool,
    getAgent: async (id) => AGENTS[id] ?? null,
    getTemplate: async () => null,
    launchTemplate: async () => {
      throw new Error("no launches here");
    },
    chat: streams,
    publishUiEvent: () => {},
    log: { warn: vi.fn(), info: vi.fn() },
  });
  await app?.close();
  app = Fastify();
  await registerStreamRoutes(app, { pool, streams, handleAgentError });
});

async function settle(): Promise<void> {
  await streams.waitForInFlightDeliveries(1_000);
}

async function newTask(assignee: string | null = ASSIGNEE): Promise<Task> {
  const task = await tasks.createTask({ projectId, title: "Fix login" }, USER);
  if (assignee)
    await tasks.updateTask(task.id, { assignedAgentId: assignee }, USER);
  await settle();
  prompts = [];
  return task;
}

function postBlock(rootId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/streams/${rootId}/blocks`,
    headers: { "content-type": "application/json" },
    payload,
  });
}

describe("task stream root", () => {
  it("posts the assignment into the task's stream, delivered to the agent", async () => {
    const task = await tasks.createTask(
      { projectId, title: "Ship it with @Helper" },
      USER
    );
    await tasks.updateTask(task.id, { assignedAgentId: ASSIGNEE }, USER);
    await settle();
    const { rows } = await pool.query(
      "SELECT author_kind, to_agent_id, text, delivered FROM blocks WHERE stream_id = $1",
      [task.id]
    );
    expect(rows).toEqual([
      {
        author_kind: "user",
        to_agent_id: ASSIGNEE,
        text: `You're assigned to task ${task.id} — Ship it with @Helper. This stream is the task's conversation; reply here.`,
        delivered: true,
      },
    ]);
    // Only the assignee hears of it, despite the @mention in the title.
    expect(prompts.map((p) => p.agentId)).toEqual([ASSIGNEE]);
    expect(prompts[0]!.text).toContain(
      `Task ${task.id} — Ship it with @Helper (Backlog). This is the task's conversation.`
    );
    expect(prompts[0]!.text).toContain(
      "Your reply appears in the task's conversation"
    );
  });

  it("delivers a person's post to the current assignee", async () => {
    const task = await newTask();
    const res = await postBlock(task.id, { text: "Any progress?" });
    expect(res.statusCode).toBe(200);
    const block = res.json().block;
    expect(block).toMatchObject({ streamId: task.id, toAgentId: ASSIGNEE });
    await settle();
    expect(prompts).toEqual([
      {
        agentId: ASSIGNEE,
        text: expect.stringContaining(`(id: ${block.id}, from: user)`),
      },
    ]);
    expect(prompts[0]!.text).toContain(`Task ${task.id} — Fix login (Backlog)`);
  });

  it("refuses a post to a task with no agent", async () => {
    const task = await newTask(null);
    const res = await postBlock(task.id, { text: "hello?" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/assign an agent first/);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1",
      [task.id]
    );
    expect(rows[0].n).toBe(0);
  });

  it("delivers an @mention to that agent on the task", async () => {
    const task = await newTask(HELPER);
    await tasks.updateTask(task.id, { assignedAgentId: ASSIGNEE }, USER);
    await settle();
    prompts = [];
    const res = await postBlock(task.id, { text: "@Helper can you check?" });
    expect(res.statusCode).toBe(200);
    expect(res.json().block).toMatchObject({
      toAgentId: HELPER,
      data: { mentions: [HELPER] },
    });
    await settle();
    expect(prompts.map((p) => p.agentId)).toEqual([HELPER]);
    expect(prompts[0]!.text).toContain("Addressed to you by @mention.");
  });

  it("lands an agent's reply back in the task's stream", async () => {
    const task = await newTask();
    const asked = (await postBlock(task.id, { text: "Status?" })).json().block;
    await settle();
    const reply = await streams.post(ASSIGNEE, {
      text: "Halfway",
      replyTo: asked.id,
    });
    expect(reply).toMatchObject({
      streamId: task.id,
      threadId: asked.id,
      replyTo: asked.id,
    });
  });

  it("lets another agent on the task post into its stream, and refuses others", async () => {
    const task = await newTask(HELPER);
    await tasks.updateTask(task.id, { assignedAgentId: ASSIGNEE }, USER);
    const asked = (await postBlock(task.id, { text: "Status?" })).json().block;
    await settle();
    // HELPER is on the task (an earlier assignee) though not addressed.
    const helped = await streams.post(HELPER, {
      text: "I can help",
      replyTo: asked.id,
    });
    expect(helped.streamId).toBe(task.id);

    await expect(
      streams.post(STRANGER, { text: "me too", replyTo: asked.id })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(
        new RegExp(`You are not on task ${task.id}`)
      ),
    });
    await expect(
      streams.post(STRANGER, { text: "hi" }, { root: task.id })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("task_comment posts at the top of the task's stream", async () => {
    const task = await newTask(HELPER);
    await tasks.updateTask(task.id, { assignedAgentId: ASSIGNEE }, USER);
    await settle();
    prompts = [];
    const { blockId } = await tasks.comment(task.id, ASSIGNEE, "PR is up");
    const { rows } = await pool.query(
      "SELECT stream_id, author_kind, author_agent_id, to_agent_id, thread_id FROM blocks WHERE id = $1",
      [blockId]
    );
    expect(rows[0]).toEqual({
      stream_id: task.id,
      author_kind: "agent",
      author_agent_id: ASSIGNEE,
      to_agent_id: null,
      thread_id: null,
    });
    expect(prompts).toEqual([]);

    // Addressed to another agent on the task, it is delivered.
    await tasks.comment(task.id, ASSIGNEE, "please review", HELPER);
    await settle();
    expect(prompts.map((p) => p.agentId)).toEqual([HELPER]);
    expect(prompts[0]!.text).toContain(`Task ${task.id} — Fix login`);
    await expect(tasks.comment(task.id, STRANGER, "hi")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("serves the task's feed, read marks and unread counts", async () => {
    const task = await newTask();
    await tasks.comment(task.id, ASSIGNEE, "Done with step one");
    const feed = await app.inject({
      method: "GET",
      url: `/api/v1/streams/${task.id}/blocks`,
    });
    expect(feed.statusCode).toBe(200);
    const texts = (
      feed.json().entries as Array<{ block?: { text: string } }>
    ).map((e) => e.block?.text);
    expect(texts).toEqual([
      expect.stringContaining("You're assigned to task"),
      "Done with step one",
    ]);

    const summary = await streams.store.unreadSummary();
    expect(summary.tasks?.[task.id]).toEqual({
      unread: 1,
      pendingQuestions: 0,
    });
    expect(summary.agents[task.id]).toBeUndefined();
    const read = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${task.id}/read`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(read.json()).toEqual({ unreadCount: 0 });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/streams/tsk_nope/blocks",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Task not found.");
  });

  it("deleting the task deletes its conversation", async () => {
    const task = await newTask();
    await tasks.deleteTask(task.id);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1",
      [task.id]
    );
    expect(rows[0].n).toBe(0);
  });

  it("takes back a task's queued prompts before deleting it", async () => {
    const task = await newTask();
    holding = true;
    const queued = (
      await postBlock(task.id, { text: "Held behind a turn" })
    ).json().block;
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]!.blockId).toBe(queued.id);

    await tasks.deleteTask(task.id);
    expect(waiting).toEqual([]);
    // The turn ends: nothing from the deleted task reaches the engine.
    holding = false;
    await settle();
    expect(prompts).toEqual([]);
    expect(await streams.store.getById(queued.id)).toBeNull();
  });

  it("refuses to delete while a delivery cannot be taken back", async () => {
    const task = await newTask();
    holding = true;
    await postBlock(task.id, { text: "On its way" });
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    // An engine that claimed the prompt: the runtime no longer has it queued.
    const [claimed] = waiting.splice(0, 1);
    await expect(
      streams.closeStream(task.id, { settleMs: 100 })
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    // The stream is open again, and the task is still there.
    expect(await streams.rootExists(task.id)).toBe(true);
    claimed!.release();
    await settle();
    await tasks.deleteTask(task.id);
    expect(await streams.rootExists(task.id)).toBe(false);
  });

  it("refuses posts into a task stream being deleted", async () => {
    const task = await newTask();
    await streams.closeStream(task.id);
    const res = await postBlock(task.id, { text: "too late" });
    expect(res.statusCode).toBe(409);
    await expect(
      tasks.comment(task.id, ASSIGNEE, "too late")
    ).rejects.toMatchObject({ statusCode: 409 });
    streams.releaseStream(task.id);
    expect((await postBlock(task.id, { text: "ok now" })).statusCode).toBe(200);
  });

  it("attaches a file uploaded under an earlier assignee", async () => {
    const task = await newTask(HELPER);
    const fileId = (
      await pool.query(
        `INSERT INTO files (agent_id, file_name, size_bytes, mime_type)
         VALUES ($1, 'shot.png', 10, 'image/png') RETURNING id`,
        [HELPER]
      )
    ).rows[0].id as number;
    const thread = (await postBlock(task.id, { text: "Look at this" })).json()
      .block;
    await tasks.updateTask(task.id, { assignedAgentId: ASSIGNEE }, USER);
    await settle();

    // A draft sent after the reassignment goes to the new assignee.
    const draft = await postBlock(task.id, {
      text: "the screenshot",
      attachments: [{ type: "file", fileId }],
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().block).toMatchObject({
      toAgentId: ASSIGNEE,
      attachments: [{ type: "file", fileId, ownerAgentId: HELPER }],
    });

    // A reply in the earlier assignee's thread, with the same file.
    const reply = await postBlock(task.id, {
      text: "again",
      replyTo: thread.id,
      attachments: [{ type: "file", fileId }],
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().block.attachments[0]).toMatchObject({
      fileId,
      ownerAgentId: HELPER,
    });

    // Not a file of anyone on the task: still unknown.
    const foreign = (
      await pool.query(
        `INSERT INTO files (agent_id, file_name, size_bytes, mime_type)
         VALUES ($1, 'x.png', 10, 'image/png') RETURNING id`,
        [STRANGER]
      )
    ).rows[0].id as number;
    const refused = await postBlock(task.id, {
      text: "nope",
      attachments: [{ type: "file", fileId: foreign }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Unknown file/);
  });

  it("lets the task's agents react to its blocks, and no one else", async () => {
    const task = await newTask();
    const asked = (await postBlock(task.id, { text: "Status?" })).json().block;
    await settle();
    // The MCP react tool passes the agent's own id as the stream.
    const reacted = await streams.addReaction(ASSIGNEE, asked.id, "👍", {
      kind: "agent",
      agentId: ASSIGNEE,
    });
    expect(reacted.reactions).toEqual([
      expect.objectContaining({ emoji: "👍" }),
    ]);
    const removed = await streams.removeReaction(ASSIGNEE, asked.id, "👍", {
      kind: "agent",
      agentId: ASSIGNEE,
    });
    expect(removed.reactions).toEqual([]);
    await expect(
      streams.addReaction(STRANGER, asked.id, "👍", {
        kind: "agent",
        agentId: STRANGER,
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
