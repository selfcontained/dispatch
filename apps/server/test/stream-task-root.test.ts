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
import {
  TaskWatchNotifier,
  type WatchDelivery,
} from "../src/tasks/watch-notifier.js";
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
/** When set, the stream's agent lookups wait on it, pausing a write mid-way. */
let agentGate: Promise<void> | null;
let gateHits: number;
let waiting: Array<{
  agentId: string;
  blockId?: string;
  release: () => void;
  reject: (error: Error) => void;
}>;
let projectId: string;
let watches: TaskWatchNotifier;
let watchPrompts: string[];
let watchDeliver: (
  id: string,
  text: string,
  options: WatchDelivery
) => Promise<void>;

const ASSIGNEE = "agt_task_owner";
const HELPER = "agt_task_helper";
/** In another project. */
const STRANGER = "agt_task_stranger";
/** In the task's project, never on the task. */
const PEER = "agt_task_peer";
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
  [PEER]: { id: PEER, name: "Peer", filesDir: null, status: "running" },
};
const USER = { kind: "user" } as const;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  watches?.dispose();
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  watches?.dispose();
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
  await pool.query(`UPDATE agents SET project_id = $1 WHERE id <> $2`, [
    projectId,
    STRANGER,
  ]);
  watchPrompts = [];
  watchDeliver = async (_id, text, options) => {
    if (await options.beforeSubmit()) watchPrompts.push(text);
    else throw new Error("withdrawn");
  };
  watches = new TaskWatchNotifier({
    pool,
    debounceMs: 100,
    settleMs: 0,
    projectForAgent: async (id) => (id === STRANGER ? "elsewhere" : projectId),
    deliver: (id, text, options) => watchDeliver(id, text, options),
    warn: () => {},
  });
  prompts = [];
  holding = false;
  waiting = [];
  agentGate = null;
  gateHits = 0;
  streams = new StreamService({
    pool,
    onTaskActivity: (id) => watches.schedule(id),
    publishUiEvent: () => {},
    getAgent: async (id) => {
      if (agentGate) {
        gateHits++;
        await agentGate;
      }
      return AGENTS[id] ?? null;
    },
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
    agentProject: async (id) =>
      id === STRANGER ? "prj_elsewhere" : AGENTS[id] ? projectId : null,
  });
  tasks = new TaskService({
    pool,
    watches,
    getAgent: async (id) =>
      AGENTS[id]
        ? {
            ...AGENTS[id]!,
            projectId: id === STRANGER ? "prj_elsewhere" : projectId,
          }
        : null,
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
        new RegExp(`You are not in task ${task.id}'s project`)
      ),
    });
    await expect(
      streams.post(STRANGER, { text: "hi" }, { root: task.id })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets an agent in the task's project comment, reply, react and read without joining it", async () => {
    const task = await newTask();
    const asked = (await postBlock(task.id, { text: "Status?" })).json().block;
    await settle();
    prompts = [];

    const { blockId } = await tasks.comment(task.id, PEER, "I filed this");
    const replied = await streams.post(PEER, {
      text: "Context: see the login bug",
      replyTo: asked.id,
    });
    expect(replied).toMatchObject({ streamId: task.id, threadId: asked.id });
    await streams.addReaction(PEER, asked.id, "👀", {
      kind: "agent",
      agentId: PEER,
    });
    await expect(streams.getMessage(PEER, asked.id)).resolves.toBeTruthy();
    await expect(streams.getThread(PEER, asked.id)).resolves.toBeTruthy();

    // Commenting neither puts it on the task nor moves the assignment.
    const detail = await tasks.getTaskDetail(task.id);
    expect(detail.agents.map((a) => a.agentId)).toEqual([ASSIGNEE]);
    expect(detail.assignedAgentId).toBe(ASSIGNEE);

    // Like any author in the stream, a person's reply to it reaches it.
    await settle();
    prompts = [];
    const answer = await postBlock(task.id, {
      text: "Thanks",
      replyTo: blockId,
    });
    expect(answer.statusCode).toBe(200);
    await settle();
    expect(prompts.map((p) => p.agentId)).toEqual([PEER]);
    // A person's unaddressed post still reaches only the assignee.
    prompts = [];
    await postBlock(task.id, { text: "Anyone?" });
    await settle();
    expect(prompts.map((p) => p.agentId)).toEqual([ASSIGNEE]);
  });

  it("refuses an agent from another project everywhere in the conversation", async () => {
    const task = await newTask();
    const asked = (await postBlock(task.id, { text: "Status?" })).json().block;
    await settle();
    const notInProject = expect.objectContaining({
      message: expect.stringMatching(/not in task .*'s project/),
    });
    await expect(tasks.comment(task.id, STRANGER, "hi")).rejects.toEqual(
      notInProject
    );
    await expect(
      streams.post(STRANGER, { text: "hi", replyTo: asked.id })
    ).rejects.toEqual(notInProject);
    await expect(
      streams.addReaction(STRANGER, asked.id, "👍", {
        kind: "agent",
        agentId: STRANGER,
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(streams.getMessage(STRANGER, asked.id)).rejects.toMatchObject({
      statusCode: 404,
    });
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
      statusCode: 400,
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

  describe("removing an agent from the task", () => {
    async function assignmentBlockFor(taskId: string, agentId: string) {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM blocks WHERE stream_id = $1 AND to_agent_id = $2 ORDER BY created_at LIMIT 1",
        [taskId, agentId]
      );
      return rows[0]!.id;
    }

    it("closes the conversation to it, even through blocks addressed to it", async () => {
      const task = await newTask();
      const assignment = await assignmentBlockFor(task.id, ASSIGNEE);
      // Still a member: replying to its assignment is fine.
      await streams.post(ASSIGNEE, { text: "On it", replyTo: assignment });
      await tasks.removeAgent(task.id, ASSIGNEE, USER);
      await expect(
        streams.post(ASSIGNEE, { text: "Still here", replyTo: assignment })
      ).rejects.toThrow(/removed from task/);
      await expect(
        tasks.comment(task.id, ASSIGNEE, "Still here")
      ).rejects.toBeInstanceOf(Error);
      // What it posted before stays.
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1 AND author_agent_id = $2",
        [task.id, ASSIGNEE]
      );
      expect(rows[0].n).toBe(1);
    });

    it("closes it to posts placed by its running task turn too", async () => {
      const task = await newTask();
      // The agent is mid-turn in the task: its own block there is the turn.
      await tasks.comment(task.id, ASSIGNEE, "Working on it");
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM blocks WHERE stream_id = $1 AND author_agent_id = $2 ORDER BY created_at DESC LIMIT 1",
        [task.id, ASSIGNEE]
      );
      const turns = (streams as unknown as { turns: { openTurn: unknown } })
        .turns;
      const openTurn = vi
        .spyOn(
          turns as { openTurn: (id: string) => Promise<unknown> },
          "openTurn"
        )
        .mockResolvedValue({ payload: { blockId: rows[0]!.id } });
      try {
        const mine = await streams.post(ASSIGNEE, { text: "Still mine" });
        expect(mine.streamId).toBe(task.id);
        await tasks.removeAgent(task.id, ASSIGNEE, USER);
        await expect(
          streams.post(ASSIGNEE, { text: "Still here" })
        ).rejects.toThrow(/removed from task/);
      } finally {
        openTurn.mockRestore();
      }
    });

    it("waits for a send it overlaps, then takes that prompt back too", async () => {
      const task = await newTask();
      holding = true;
      let open!: () => void;
      agentGate = new Promise<void>((resolve) => (open = resolve));
      // A person's post to the task, admitted and paused while it resolves
      // the assignee as its recipient.
      const send = postBlock(task.id, { text: "paused mid-send" });
      await vi.waitFor(() => expect(gateHits).toBeGreaterThan(0));
      let removed = false;
      const removal = tasks
        .removeAgent(task.id, ASSIGNEE, USER)
        .then(() => (removed = true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The removal is waiting for the send it admitted.
      expect(removed).toBe(false);
      agentGate = null;
      open();
      expect((await send).statusCode).toBe(200);
      await removal;
      // The send's prompt went to the agent's queue and was taken back.
      expect(waiting).toEqual([]);
      holding = false;
      await settle();
      expect(prompts).toEqual([]);
      // The fence is lifted: the task takes posts again (to no one, now).
      expect((await postBlock(task.id, { text: "after" })).statusCode).toBe(
        400
      );
    });

    it("takes back the task's prompts queued at it, and only those", async () => {
      const task = await newTask();
      holding = true;
      const queued = (
        await postBlock(task.id, { text: "Held behind a turn" })
      ).json().block;
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      await tasks.removeAgent(task.id, ASSIGNEE, USER);
      expect(waiting).toEqual([]);
      holding = false;
      await settle();
      expect(prompts).toEqual([]);
      // The block itself stays in the conversation.
      expect(await streams.store.getById(queued.id)).not.toBeNull();
    });

    it("refuses while a delivery to it cannot be taken back", async () => {
      const task = await newTask();
      holding = true;
      await postBlock(task.id, { text: "On its way" });
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      const [claimed] = waiting.splice(0, 1);
      await expect(
        tasks.removeAgent(task.id, ASSIGNEE, USER)
      ).rejects.toMatchObject({ status: 409, code: "delivery_in_flight" });
      expect((await tasks.getTaskDetail(task.id)).assignedAgentId).toBe(
        ASSIGNEE
      );
      claimed!.release();
      await settle();
      await tasks.removeAgent(task.id, ASSIGNEE, USER);
      expect((await tasks.getTaskDetail(task.id)).agents).toEqual([]);
    });
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

  describe("a write racing the task's deletion", () => {
    function gate(): () => void {
      let open!: () => void;
      agentGate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        agentGate = null;
        open();
      };
    }

    async function blocksLeft(taskId: string): Promise<number> {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1",
        [taskId]
      );
      return rows[0].n;
    }

    it("waits for an admitted send, then takes its prompt back", async () => {
      const task = await newTask();
      holding = true;
      const release = gate();
      const send = postBlock(task.id, { text: "paused mid-send" });
      await vi.waitFor(() => expect(gateHits).toBeGreaterThan(0));
      let deleted = false;
      const deletion = tasks.deleteTask(task.id).then(() => (deleted = true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The delete is waiting for the send it admitted.
      expect(deleted).toBe(false);
      release();
      expect((await send).statusCode).toBe(200);
      await deletion;
      holding = false;
      await settle();
      expect(waiting).toEqual([]);
      expect(prompts).toEqual([]);
      expect(await blocksLeft(task.id)).toBe(0);
    });

    it("refuses a send the delete overtook before it was admitted", async () => {
      const task = await newTask();
      // An agent's post paused before it found its place, so not admitted.
      const release = gate();
      const reply = streams.post(ASSIGNEE, { text: "late" }, { root: task.id });
      await vi.waitFor(() => expect(gateHits).toBeGreaterThan(0));
      await tasks.deleteTask(task.id);
      release();
      await expect(reply).rejects.toMatchObject({ statusCode: 404 });
      // A person's post whose route check passed before the delete.
      await expect(
        streams.sendUserPost(task.id, { text: "late too", to: ASSIGNEE })
      ).rejects.toMatchObject({ statusCode: 404 });
      await settle();
      expect(prompts).toEqual([]);
      expect(await blocksLeft(task.id)).toBe(0);
    });

    it("refuses the delete when an admitted send outlasts the window", async () => {
      const task = await newTask();
      const release = gate();
      const send = postBlock(task.id, { text: "stuck" });
      await vi.waitFor(() => expect(gateHits).toBeGreaterThan(0));
      await expect(
        streams.closeStream(task.id, { settleMs: 100 })
      ).rejects.toMatchObject({ statusCode: 409 });
      release();
      expect((await send).statusCode).toBe(200);
      expect(await streams.rootExists(task.id)).toBe(true);
    });
  });
});

describe("task watches", () => {
  it("coalesces events and threaded chat, suppresses self and addressed posts", async () => {
    const task = await newTask();
    await tasks.watch(task.id, PEER);
    await tasks.updateTask(task.id, { title: "New title" }, USER);
    const post = await tasks.comment(task.id, HELPER, "Useful update");
    await streams.post(HELPER, {
      text: "Thread detail",
      replyTo: post.blockId,
    });
    await tasks.comment(task.id, PEER, "Self post");
    await tasks.updateTask(
      task.id,
      { body: "Self edit" },
      { kind: "agent", agentId: PEER }
    );
    await expect.poll(() => watchPrompts.length).toBe(1);
    expect(watchPrompts[0]).toContain("updated");
    expect(watchPrompts[0]).toContain("Useful update");
    expect(watchPrompts[0]).toContain("Thread detail");
    expect(watchPrompts[0]).not.toContain("Self post");
    expect(watchPrompts[0]).not.toContain("Self edit");
    await watches.flushTask(task.id);
    expect(watchPrompts).toHaveLength(1);
    // The assignee already receives task posts directly.
    await tasks.watch(task.id, ASSIGNEE);
    await tasks.comment(task.id, HELPER, "Addressed", ASSIGNEE);
    await settle();
    await watches.flush(task.id, ASSIGNEE);
    expect(watchPrompts).toHaveLength(1);
  });

  it("renders readable movement lines with column keys and actor names", async () => {
    const task = await newTask(null);
    const ready = await tasks.resolveColumnKey(projectId, "ready");
    const working = await tasks.resolveColumnKey(projectId, "in_progress");
    await tasks.updateTask(task.id, { columnId: ready.id }, USER);
    await tasks.watch(task.id, PEER);
    await tasks.updateTask(task.id, { columnId: working.id }, USER);
    const event = (
      await pool.query(
        `SELECT id FROM task_events WHERE task_id = $1 AND kind = 'moved' ORDER BY created_at DESC LIMIT 1`,
        [task.id]
      )
    ).rows[0];
    await watches.flushTask(task.id);
    expect(watchPrompts[0]!.split("\n")).toContain(
      `[event ${event.id}] user: moved ready → in_progress`
    );
  });

  it("notifies questions, forms and their new answer blocks but skips edits", async () => {
    const task = await newTask();
    await tasks.watch(task.id, PEER);
    const question = await streams.post(
      HELPER,
      {
        text: "Which option?",
        to: ASSIGNEE,
        question: { options: [{ label: "Proceed" }] },
      },
      { root: task.id }
    );
    await streams.answerQuestion(task.id, question.id, { value: "Proceed" });
    const form = await streams.post(
      HELPER,
      {
        text: "Report details",
        to: ASSIGNEE,
        form: { fields: [{ id: "name", label: "Name", type: "text" }] },
      },
      { root: task.id }
    );
    await streams.submitForm(task.id, form.id, { values: { name: "Ada" } });
    await watches.flushTask(task.id);
    expect(watchPrompts).toHaveLength(1);
    expect(watchPrompts[0]).toContain("Which option?");
    expect(watchPrompts[0]).toContain("Proceed");
    expect(watchPrompts[0]).toContain("Report details");
    expect(watchPrompts[0]).toContain("Ada");
    await streams.store.update(question.id, { text: "Edited question" });
    await watches.flushTask(task.id);
    expect(watchPrompts).toHaveLength(1);
  });

  it("retains cursor for offline/failed delivery and retries from persisted state", async () => {
    const task = await newTask();
    await tasks.watch(task.id, PEER);
    const cursor = async () =>
      (
        await pool.query(
          `SELECT notified_through::text AS value FROM task_watches WHERE task_id = $1`,
          [task.id]
        )
      ).rows[0]?.value;
    const before = await cursor();
    await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [
      PEER,
    ]);
    await tasks.comment(task.id, HELPER, "While offline");
    await watches.flushTask(task.id);
    expect(await cursor()).toBe(before);
    await pool.query(`UPDATE agents SET status = 'running' WHERE id = $1`, [
      PEER,
    ]);
    watchDeliver = async () => {
      throw new Error("inert runtime");
    };
    await watches.flushTask(task.id);
    expect(await cursor()).toBe(before);
    watchDeliver = async (_id, text) => {
      watchPrompts.push(text);
    };
    await watches.recover(PEER);
    await expect.poll(() => watchPrompts.length).toBe(1);
    expect(watchPrompts[0]).toContain("While offline");
    expect(await cursor()).not.toBe(before);
  });

  it("advances only on acceptance and aborts queued watches on unwatch/delete", async () => {
    const task = await newTask();
    await tasks.watch(task.id, PEER);
    const before = (
      await pool.query(
        `SELECT notified_through::text AS value FROM task_watches WHERE task_id = $1`,
        [task.id]
      )
    ).rows[0].value;
    let accept!: () => void;
    watchDeliver = async (_id, text, options) =>
      new Promise<void>((resolve, reject) => {
        accept = () => {
          watchPrompts.push(text);
          resolve();
        };
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("withdrawn")),
          { once: true }
        );
      });
    await tasks.comment(task.id, HELPER, "Pending");
    const pending = watches.flushTask(task.id);
    await expect.poll(() => typeof accept).toBe("function");
    expect(
      (
        await pool.query(
          `SELECT notified_through::text AS value FROM task_watches WHERE task_id = $1`,
          [task.id]
        )
      ).rows[0].value
    ).toBe(before);
    await tasks.unwatch(task.id, PEER);
    await pending;
    expect(watchPrompts).toHaveLength(0);
    await tasks.watch(task.id, PEER);
    accept = undefined as never;
    await tasks.comment(task.id, HELPER, "Pending delete");
    const deleting = watches.flushTask(task.id);
    await expect.poll(() => typeof accept).toBe("function");
    await tasks.deleteTask(task.id);
    await deleting;
    expect(
      (
        await pool.query(`SELECT * FROM task_watches WHERE task_id = $1`, [
          task.id,
        ])
      ).rows
    ).toHaveLength(0);
    expect(watchPrompts).toHaveLength(0);
  });

  it("caps burst notices, deletes archived watches and drops removed task agents", async () => {
    const task = await newTask();
    await tasks.watch(task.id, PEER);
    for (let i = 0; i < 18; i++)
      await tasks.store.insertEvent(task.id, "link_added", USER, {
        label: `Link ${i}`,
      });
    await watches.flushTask(task.id);
    expect(watchPrompts).toHaveLength(1);
    expect(watchPrompts[0]).toContain("+3 more");
    await watches.flushTask(task.id);
    expect(watchPrompts).toHaveLength(1);
    await pool.query(`UPDATE agents SET deleted_at = now() WHERE id = $1`, [
      PEER,
    ]);
    await watches.recover();
    expect(await tasks.watching(task.id, PEER)).toBe(false);
    await tasks.watch(task.id, ASSIGNEE);
    await tasks.removeAgent(task.id, ASSIGNEE, USER);
    expect(await tasks.watching(task.id, ASSIGNEE)).toBe(false);
    await expect(tasks.watch(task.id, ASSIGNEE)).rejects.toMatchObject({
      status: 403,
    });
  });
});
