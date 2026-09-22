import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { BlockAuthor } from "@dispatch/shared";

import {
  authorOf,
  BlockStore,
  isBlockId,
  sameAuthor,
} from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: BlockStore;

const A = "agt_blocks_a";
const B = "agt_blocks_b";
const GONE = "agt_blocks_gone";
const USER: BlockAuthor = { kind: "user" };
const agent = (agentId: string): BlockAuthor => ({ kind: "agent", agentId });
const NIL = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new BlockStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, deleted_at)
     VALUES ($1, 'A', '/tmp', 'running', NULL),
            ($2, 'B', '/tmp', 'running', NULL),
            ($3, 'Gone', '/tmp', 'stopped', now())`,
    [A, B, GONE]
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM blocks");
});

/** Give a row a fixed created_at so ordering by time is deterministic. */
async function stamp(id: string, second: number): Promise<void> {
  await pool.query(`UPDATE blocks SET created_at = $2 WHERE id = $1`, [
    id,
    new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
  ]);
}

async function seedAgentPosts(streamId: string, n: number, from = 0) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = await store.insert({
      streamId,
      author: agent(streamId),
      text: `m${i}`,
    });
    await stamp(b.id, from + i);
    ids.push(b.id);
  }
  return ids;
}

describe("isBlockId / authorOf / sameAuthor", () => {
  it("accepts only well-formed uuids", () => {
    expect(isBlockId("7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5")).toBe(true);
    expect(isBlockId("7C1D2E3F-4A5B-4C6D-8E7F-90A1B2C3D4E5")).toBe(true);
    expect(isBlockId("nope")).toBe(false);
    expect(isBlockId("7c1d2e3f4a5b4c6d8e7f90a1b2c3d4e5")).toBe(false);
    expect(isBlockId(42)).toBe(false);
    expect(isBlockId(null)).toBe(false);
  });

  it("builds and compares authors", () => {
    expect(authorOf("user", null)).toEqual({ kind: "user" });
    expect(authorOf("agent", A)).toEqual({ kind: "agent", agentId: A });
    expect(sameAuthor(USER, { kind: "user" })).toBe(true);
    expect(sameAuthor(agent(A), agent(A))).toBe(true);
    expect(sameAuthor(agent(A), agent(B))).toBe(false);
    expect(sameAuthor(agent(A), USER)).toBe(false);
  });
});

describe("BlockStore.insert", () => {
  it("inserts with defaults and round-trips the wire shape", async () => {
    const b = await store.insert({
      streamId: A,
      author: agent(A),
      text: "hello",
    });
    expect(b).toEqual({
      id: expect.any(String),
      streamId: A,
      author: { kind: "agent", agentId: A },
      toAgentId: null,
      kind: "text",
      threadId: null,
      replyTo: null,
      text: "hello",
      data: null,
      state: null,
      attachments: [],
      delivered: null,
      readAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(isBlockId(b.id)).toBe(true);
    expect(b.createdAt).toBe(b.updatedAt);
    // Absent, not null, on the wire.
    expect("origin" in b).toBe(false);
    expect("launchedByAgentId" in b).toBe(false);
    expect("reactions" in b).toBe(false);
    expect("replyCount" in b).toBe(false);
    expect(await store.getById(b.id)).toEqual(b);
    expect(await store.getById(NIL)).toBeNull();
  });

  it("stores a user block addressed to an agent with a pending delivery", async () => {
    const b = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "do it",
      delivered: null,
    });
    expect(b).toMatchObject({
      author: { kind: "user" },
      toAgentId: A,
      delivered: null,
    });
    await store.setDelivered(b.id, true);
    expect((await store.getById(b.id))?.delivered).toBe(true);
    await store.setDelivered(b.id, false);
    expect((await store.getById(b.id))?.delivered).toBe(false);
  });

  it("stores origin and launchedByAgentId, and leaves both off the wire otherwise", async () => {
    const launch = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "Build it",
      delivered: true,
      origin: "launch",
      launchedByAgentId: B,
    });
    expect(launch).toMatchObject({
      origin: "launch",
      launchedByAgentId: B,
      delivered: true,
    });
    expect(await store.getById(launch.id)).toEqual(launch);

    const own = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "Build it",
      origin: "launch",
    });
    expect(own.origin).toBe("launch");
    expect("launchedByAgentId" in own).toBe(false);
  });

  it("stores kind, data, state and attachments as given", async () => {
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "Which?",
      data: { options: [{ label: "x" }, { label: "y", value: "Y" }] },
      state: {},
      attachments: [{ type: "link", url: "https://e.com", title: "e" }],
    });
    expect(q.kind).toBe("question");
    expect(q.data).toEqual({
      options: [{ label: "x" }, { label: "y", value: "Y" }],
    });
    expect(q.state).toEqual({});
    expect(q.attachments).toEqual([
      { type: "link", url: "https://e.com", title: "e" },
    ]);

    const review = await store.insert({
      streamId: A,
      author: agent(B),
      toAgentId: A,
      kind: "review",
      data: { verdict: "comment", summary: "s", findings: [] },
      state: { findings: {} },
      delivered: null,
    });
    expect(review).toMatchObject({
      kind: "review",
      data: { verdict: "comment", summary: "s", findings: [] },
      state: { findings: {} },
      text: "",
    });
  });

  it("stores a thread reply with its root and parent", async () => {
    const root = await store.insert({
      streamId: A,
      author: agent(A),
      text: "root",
    });
    const reply = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "reply",
      delivered: true,
    });
    expect(reply).toMatchObject({ threadId: root.id, replyTo: root.id });
    const nested = await store.insert({
      streamId: A,
      author: agent(A),
      threadId: root.id,
      replyTo: reply.id,
      text: "nested",
    });
    expect(nested).toMatchObject({ threadId: root.id, replyTo: reply.id });
  });

  it("enforces the table's shape at the database", async () => {
    // An agent author needs an agent id.
    await expect(
      pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, text)
         VALUES (gen_random_uuid(), $1, 'agent', 'x')`,
        [A]
      )
    ).rejects.toThrow(/check constraint/i);
    // A thread reply names the block it replies to.
    await expect(
      pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, text, thread_id)
         VALUES (gen_random_uuid(), $1, 'user', 'x', gen_random_uuid())`,
        [A]
      )
    ).rejects.toThrow(/check constraint/i);
    // Only the launch origin exists.
    await expect(
      pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, text, origin)
         VALUES (gen_random_uuid(), $1, 'user', 'x', 'typed')`,
        [A]
      )
    ).rejects.toThrow(/check constraint/i);
    // Unknown kinds are refused; the later steps add theirs by migration.
    await expect(
      pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, text, kind)
         VALUES (gen_random_uuid(), $1, 'user', 'x', 'board')`,
        [A]
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it("insertIfAbsent keeps the first row and reports the collision", async () => {
    const id = "8a4f9e60-1111-4222-8333-444455556666";
    const first = await store.insertIfAbsent({
      id,
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "first",
    });
    expect(first?.id).toBe(id);
    const second = await store.insertIfAbsent({
      id,
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "second",
    });
    expect(second).toBeNull();
    expect((await store.getById(id))?.text).toBe("first");
    // A plain insert with a fixed id is a hard conflict.
    await expect(
      store.insert({ id, streamId: A, author: USER, toAgentId: A, text: "x" })
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe("BlockStore.update / mergeState", () => {
  it("updates only supplied fields and bumps updated_at", async () => {
    const b = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "q",
      data: { options: [{ label: "a" }] },
      state: {},
      attachments: [{ type: "link", url: "https://a.com" }],
    });
    const updated = await store.update(b.id, { text: "q2" });
    expect(updated).toMatchObject({
      text: "q2",
      data: { options: [{ label: "a" }] },
      state: {},
      attachments: [{ type: "link", url: "https://a.com" }],
    });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(b.updatedAt)
    );

    const replaced = await store.update(b.id, {
      data: { options: [{ label: "b" }] },
      state: null,
      attachments: [{ type: "code", code: "x" }],
    });
    expect(replaced).toMatchObject({
      text: "q2",
      data: { options: [{ label: "b" }] },
      state: null,
      attachments: [{ type: "code", code: "x" }],
    });
    // Data can be cleared explicitly.
    expect((await store.update(b.id, { data: null }))?.data).toBeNull();
    // An empty patch reads the row back unchanged.
    expect(await store.update(b.id, {})).toEqual(await store.getById(b.id));
    expect(await store.update(NIL, { text: "x" })).toBeNull();
  });

  it("merges state one level down, replacing scalars and arrays", async () => {
    const b = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "review",
      data: { verdict: "comment", summary: "s", findings: [] },
      state: {
        findings: {
          f1: { status: "open", by: USER, at: "t0" },
          f2: { status: "open", by: USER, at: "t0" },
        },
        note: "keep me",
        list: [1, 2],
      },
    });
    const merged = await store.mergeState(b.id, {
      findings: { f1: { status: "resolved", by: agent(A), at: "t1" } },
      list: [3],
    });
    expect(merged?.state).toEqual({
      findings: {
        f1: { status: "resolved", by: { kind: "agent", agentId: A }, at: "t1" },
        f2: { status: "open", by: USER, at: "t0" },
      },
      note: "keep me",
      list: [3],
    });
    // A scalar under a key that used to hold an object simply replaces it.
    const flattened = await store.mergeState(b.id, { findings: "gone" });
    expect((flattened?.state as { findings: unknown }).findings).toBe("gone");
    // Merging into a null state starts from an empty object.
    const plain = await store.insert({
      streamId: A,
      author: agent(A),
      text: "t",
    });
    expect(
      (await store.mergeState(plain.id, { items: { a: "done" } }))?.state
    ).toEqual({ items: { a: "done" } });
    expect(await store.mergeState(NIL, { x: 1 })).toBeNull();
    expect(await store.mergeState("nope", { x: 1 })).toBeNull();
  });
});

describe("BlockStore answers and submissions", () => {
  const answer = {
    value: "a",
    label: "a",
    by: USER,
    blockId: "00000000-0000-0000-0000-000000000001",
    at: "2026-01-01T00:00:00.000Z",
  };

  it("records an answer once, on a question only", async () => {
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "?",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    const plain = await store.insert({
      streamId: A,
      author: agent(A),
      text: "not a question",
    });
    const first = await store.recordAnswer(q.id, answer);
    expect(first?.kind === "question" && first.state.answer).toEqual(answer);
    expect(
      await store.recordAnswer(q.id, { ...answer, value: "b" })
    ).toBeNull();
    expect(
      (await store.getById(q.id))?.kind === "question" &&
        ((await store.getById(q.id)) as { state: { answer: unknown } }).state
          .answer
    ).toEqual(answer);
    expect(await store.recordAnswer(plain.id, answer)).toBeNull();
    expect(await store.recordAnswer(NIL, answer)).toBeNull();
    expect(await store.recordAnswer("nope", answer)).toBeNull();
  });

  it("records an answer on a question whose state is still null", async () => {
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      data: { options: [{ label: "a" }] },
    });
    expect(q.state).toBeNull();
    const answered = await store.recordAnswer(q.id, answer);
    expect(answered?.state).toEqual({ answer });
  });

  it("records a submission once, on a form only", async () => {
    const form = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "form",
      data: { fields: [{ id: "name", label: "Name", type: "text" }] },
      state: {},
    });
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    const submission = {
      values: { name: "Ada", count: 2, ok: true },
      by: USER,
      blockId: "00000000-0000-0000-0000-000000000002",
      at: "2026-01-01T00:00:00.000Z",
    };
    const first = await store.recordSubmission(form.id, submission);
    expect(first?.state).toEqual({ submission });
    expect(await store.recordSubmission(form.id, submission)).toBeNull();
    expect(await store.recordSubmission(q.id, submission)).toBeNull();
    expect(await store.recordSubmission("nope", submission)).toBeNull();
  });

  it("records a cancellation once, on a question or form, and never alongside an answer or submission", async () => {
    const cancellation = { by: USER, at: "2026-01-01T00:00:00.000Z" };
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    const plain = await store.insert({
      streamId: A,
      author: agent(A),
      text: "not a question",
    });
    const first = await store.recordCancellation(q.id, cancellation);
    expect(first?.kind === "question" && first.state.cancellation).toEqual(
      cancellation
    );
    // Second cancel, a plain block, and bad ids all no-op.
    expect(await store.recordCancellation(q.id, cancellation)).toBeNull();
    expect(await store.recordCancellation(plain.id, cancellation)).toBeNull();
    expect(await store.recordCancellation(NIL, cancellation)).toBeNull();
    expect(await store.recordCancellation("nope", cancellation)).toBeNull();
    // Answering a canceled question, and canceling an answered one, both fail.
    expect(
      await store.recordAnswer(q.id, {
        value: "a",
        by: USER,
        blockId: NIL,
        at: "2026-01-01T00:00:00.000Z",
      })
    ).toBeNull();
    const answered = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    await store.recordAnswer(answered.id, {
      value: "a",
      by: USER,
      blockId: NIL,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(
      await store.recordCancellation(answered.id, cancellation)
    ).toBeNull();

    const form = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "form",
      data: { fields: [{ id: "name", label: "Name", type: "text" }] },
      state: {},
    });
    const canceledForm = await store.recordCancellation(form.id, cancellation);
    expect(
      canceledForm?.kind === "form" && canceledForm.state.cancellation
    ).toEqual(cancellation);
    expect(
      await store.recordSubmission(form.id, {
        values: { name: "Ada" },
        by: USER,
        blockId: NIL,
        at: "2026-01-01T00:00:00.000Z",
      })
    ).toBeNull();
  });
});

describe("BlockStore read state", () => {
  it("counts and marks unread agent blocks for people only, optionally up to a block", async () => {
    const ids = await seedAgentPosts(A, 3);
    // User blocks and agent blocks addressed to an agent are never unread.
    const u = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "u",
    });
    await stamp(u.id, 3);
    const peer = await store.insert({
      streamId: A,
      author: agent(A),
      toAgentId: B,
      text: "peer",
    });
    await stamp(peer.id, 4);
    await seedAgentPosts(B, 1);
    expect(await store.countUnread(A)).toBe(3);

    const partial = await store.markRead(A, ids[1]);
    expect(partial.updated).toBe(2);
    expect(partial.readAt).toEqual(expect.any(String));
    expect(partial.upToAt).toBe((await store.getById(ids[1]))!.createdAt);
    expect(await store.countUnread(A)).toBe(1);
    expect((await store.getById(ids[2]))?.readAt).toBeNull();
    expect((await store.getById(ids[0]))?.readAt).toBe(partial.readAt);

    // Unknown bound marks nothing; a bound on another stream marks nothing.
    expect(await store.markRead(A, NIL)).toEqual({
      updated: 0,
      readAt: null,
      upToAt: null,
    });
    const other = (await seedAgentPosts(B, 1, 10))[0];
    expect((await store.markRead(A, other)).updated).toBe(0);

    const all = await store.markRead(A);
    expect(all).toEqual({
      updated: 1,
      readAt: expect.any(String),
      upToAt: null,
    });
    expect(await store.countUnread(A)).toBe(0);
    expect(await store.countUnread(B)).toBe(2);
    // Nothing left: nothing stamped.
    expect(await store.markRead(A)).toEqual({
      updated: 0,
      readAt: null,
      upToAt: null,
    });
  });

  it("treats malformed ids as not found instead of erroring", async () => {
    expect(await store.getById("nope")).toBeNull();
    expect(await store.update("nope", { text: "x" })).toBeNull();
    expect((await store.markRead(A, "nope")).updated).toBe(0);
    await expect(store.setDelivered("nope", true)).resolves.toBeUndefined();
    await expect(
      store.setReactionDelivered("nope", true)
    ).resolves.toBeUndefined();
    expect(await store.listReactions("nope")).toEqual([]);
    expect(await store.deleteReaction("nope", USER, "👍")).toBe(false);
    expect(await store.countLaterPostsBySameAuthor("nope")).toBe(0);
    expect(await store.listThread("nope")).toBeNull();
    expect(await store.threadParticipants("nope", USER)).toEqual([]);
  });

  it("summarises unread and open input per live agent", async () => {
    await store.insert({ streamId: A, author: agent(A), text: "1" });
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "?",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    const form = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "form",
      data: { fields: [{ id: "f", label: "F", type: "text" }] },
      state: {},
    });
    await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "ignored",
    });
    // A question for another agent is not the user's to answer.
    await store.insert({
      streamId: A,
      author: agent(A),
      toAgentId: B,
      kind: "question",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    await store.insert({ streamId: GONE, author: agent(GONE), text: "x" });
    await store.insert({
      streamId: "agt_blocks_unknown",
      author: agent("agt_blocks_unknown"),
      text: "x",
    });
    expect(await store.unreadSummary()).toEqual({
      agents: { [A]: { unread: 3, pendingQuestions: 2 } },
    });

    // Read but still open keeps the agent listed.
    await store.markRead(A);
    expect(await store.unreadSummary()).toEqual({
      agents: { [A]: { unread: 0, pendingQuestions: 2 } },
    });
    await store.recordAnswer(q.id, {
      value: "a",
      by: USER,
      blockId: q.id,
      at: new Date().toISOString(),
    });
    expect(await store.unreadSummary()).toEqual({
      agents: { [A]: { unread: 0, pendingQuestions: 1 } },
    });
    await store.recordSubmission(form.id, {
      values: { f: "v" },
      by: USER,
      blockId: form.id,
      at: new Date().toISOString(),
    });
    expect(await store.unreadSummary()).toEqual({ agents: {} });
  });

  it("openInput returns the newest open question or form for people", async () => {
    expect(await store.openInput(A)).toBeNull();
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "first?",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    await stamp(q.id, 1);
    const form = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "form",
      text: "details",
      data: { fields: [{ id: "f", label: "F", type: "text" }] },
      state: {},
    });
    await stamp(form.id, 2);
    const peer = await store.insert({
      streamId: A,
      author: agent(A),
      toAgentId: B,
      kind: "question",
      text: "peer?",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    await stamp(peer.id, 3);
    // Newest for people wins; the one addressed to an agent is skipped.
    expect((await store.openInput(A))?.id).toBe(form.id);
    await store.recordSubmission(form.id, {
      values: { f: "v" },
      by: USER,
      blockId: form.id,
      at: new Date().toISOString(),
    });
    expect((await store.openInput(A))?.id).toBe(q.id);
    await store.recordAnswer(q.id, {
      value: "a",
      by: USER,
      blockId: q.id,
      at: new Date().toISOString(),
    });
    expect(await store.openInput(A)).toBeNull();
    // Another agent's question on this stream is not this agent's.
    expect(await store.openInput(B)).toBeNull();
  });

  it("openInput skips a canceled question or form", async () => {
    const q = await store.insert({
      streamId: A,
      author: agent(A),
      kind: "question",
      text: "still open?",
      data: { options: [{ label: "a" }] },
      state: {},
    });
    expect((await store.openInput(A))?.id).toBe(q.id);
    await store.recordCancellation(q.id, {
      by: agent(A),
      at: new Date().toISOString(),
    });
    expect(await store.openInput(A)).toBeNull();
  });
});

describe("BlockStore recovery sweeps", () => {
  it("flips only pending addressed blocks to not-delivered and reports their streams", async () => {
    const pendingA = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "p1",
      delivered: null,
    });
    const pendingA2 = await store.insert({
      streamId: A,
      author: agent(B),
      toAgentId: A,
      text: "p2",
      delivered: null,
    });
    const pendingB = await store.insert({
      streamId: B,
      author: USER,
      toAgentId: B,
      text: "p3",
      delivered: null,
    });
    const settled = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "ok",
      delivered: true,
    });
    // A block for people never carries a delivery state; NULL there means nothing.
    const forPeople = await store.insert({
      streamId: A,
      author: agent(A),
      text: "hi",
    });

    const touched = await store.sweepPendingDeliveries();
    expect(touched.sort()).toEqual([A, B].sort());
    for (const id of [pendingA.id, pendingA2.id, pendingB.id]) {
      expect((await store.getById(id))?.delivered).toBe(false);
    }
    expect((await store.getById(settled.id))?.delivered).toBe(true);
    expect((await store.getById(forPeople.id))?.delivered).toBeNull();
    // Idempotent: a second sweep finds nothing.
    expect(await store.sweepPendingDeliveries()).toEqual([]);
  });

  it("flips only pending user reactions and reports their streams", async () => {
    const post = await store.insert({
      streamId: A,
      author: agent(A),
      text: "x",
    });
    const userPost = await store.insert({
      streamId: B,
      author: USER,
      toAgentId: B,
      text: "y",
    });
    const pending = await store.insertReaction({
      streamId: A,
      blockId: post.id,
      author: USER,
      emoji: "👍",
      delivered: null,
    });
    const done = await store.insertReaction({
      streamId: A,
      blockId: post.id,
      author: USER,
      emoji: "🎉",
      delivered: true,
    });
    const byAgent = await store.insertReaction({
      streamId: B,
      blockId: userPost.id,
      author: agent(B),
      emoji: "👀",
      delivered: null,
    });
    expect(await store.sweepPendingReactions()).toEqual([A]);
    const reactions = await store.listReactions(post.id);
    expect(reactions.find((r) => r.id === pending!.id)?.delivered).toBe(false);
    expect(reactions.find((r) => r.id === done!.id)?.delivered).toBe(true);
    expect((await store.listReactions(userPost.id))[0]).toMatchObject({
      id: byAgent!.id,
      delivered: null,
    });
    expect(await store.sweepPendingReactions()).toEqual([]);
  });
});

describe("BlockStore reactions", () => {
  it("adds one reaction per (author, emoji), lists them oldest first, and removes them", async () => {
    const post = await store.insert({
      streamId: A,
      author: agent(A),
      text: "x",
    });
    const first = await store.insertReaction({
      streamId: A,
      blockId: post.id,
      author: USER,
      emoji: "👍",
      delivered: null,
    });
    expect(first).toEqual({
      id: expect.any(String),
      author: { kind: "user" },
      emoji: "👍",
      delivered: null,
      createdAt: expect.any(String),
    });
    // The same author and emoji again is a no-op.
    expect(
      await store.insertReaction({
        streamId: A,
        blockId: post.id,
        author: USER,
        emoji: "👍",
        delivered: null,
      })
    ).toBeNull();
    // A different author may use the same emoji.
    const byB = await store.insertReaction({
      streamId: A,
      blockId: post.id,
      author: agent(B),
      emoji: "👍",
      delivered: null,
    });
    expect(byB?.author).toEqual({ kind: "agent", agentId: B });
    const second = await store.insertReaction({
      streamId: A,
      blockId: post.id,
      author: USER,
      emoji: "🚀",
      delivered: false,
    });
    expect(
      (await store.listReactions(post.id)).map((r) => [r.author, r.emoji])
    ).toEqual([
      [{ kind: "user" }, "👍"],
      [{ kind: "agent", agentId: B }, "👍"],
      [{ kind: "user" }, "🚀"],
    ]);

    await store.setReactionDelivered(first!.id, true);
    expect((await store.listReactions(post.id))[0]?.delivered).toBe(true);

    // Each author removes only its own.
    expect(await store.deleteReaction(post.id, agent(A), "👍")).toBe(false);
    expect(await store.deleteReaction(post.id, USER, "👍")).toBe(true);
    expect(await store.deleteReaction(post.id, USER, "👍")).toBe(false);
    expect((await store.listReactions(post.id)).map((r) => r.id)).toEqual([
      byB!.id,
      second!.id,
    ]);
    // Reactions go with the block.
    await pool.query("DELETE FROM blocks WHERE id = $1", [post.id]);
    expect(await store.listReactions(post.id)).toEqual([]);
  });

  it("counts later top-level posts by the same author, ignoring replies and other authors", async () => {
    const [first, , third] = await seedAgentPosts(A, 3);
    const userPost = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "u",
    });
    await stamp(userPost.id, 1);
    const reply = await store.insert({
      streamId: A,
      author: agent(A),
      threadId: first,
      replyTo: first,
      text: "in thread",
    });
    await stamp(reply.id, 5);
    const elsewhere = (await seedAgentPosts(B, 2, 10))[0];
    expect(await store.countLaterPostsBySameAuthor(first)).toBe(2);
    expect(await store.countLaterPostsBySameAuthor(third)).toBe(0);
    expect(await store.countLaterPostsBySameAuthor(userPost.id)).toBe(0);
    expect(await store.countLaterPostsBySameAuthor(elsewhere)).toBe(1);
    expect(await store.countLaterPostsBySameAuthor(NIL)).toBe(0);
  });
});

describe("BlockStore threads", () => {
  it("lists a thread's root and replies oldest first, with their reactions", async () => {
    const root = await store.insert({
      streamId: A,
      author: agent(A),
      text: "root",
    });
    await stamp(root.id, 0);
    const r1 = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "r1",
      delivered: true,
    });
    await stamp(r1.id, 2);
    const r2 = await store.insert({
      streamId: A,
      author: agent(A),
      threadId: root.id,
      replyTo: r1.id,
      text: "r2",
    });
    await stamp(r2.id, 1);
    await store.insertReaction({
      streamId: A,
      blockId: r1.id,
      author: agent(A),
      emoji: "👀",
      delivered: null,
    });
    // Another thread's replies stay out.
    const other = await store.insert({
      streamId: A,
      author: agent(A),
      text: "other",
    });
    await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: other.id,
      replyTo: other.id,
      text: "elsewhere",
    });

    const thread = await store.listThread(root.id);
    expect(thread?.root).toEqual(await store.getById(root.id));
    expect(thread?.replies.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(thread?.replies[1]).toMatchObject({
      replyTo: root.id,
      reactions: [
        expect.objectContaining({
          author: { kind: "agent", agentId: A },
          emoji: "👀",
        }),
      ],
    });
    expect("reactions" in thread!.replies[0]!).toBe(false);
    // A reply is not a thread root, and an unknown id is nothing.
    expect(await store.listThread(r1.id)).toBeNull();
    expect(await store.listThread(NIL)).toBeNull();
    // A root with no replies is still a thread.
    expect(await store.listThread(other.id)).toMatchObject({
      replies: [expect.objectContaining({ text: "elsewhere" })],
    });
  });

  it("lists everyone in a thread but the caller", async () => {
    const root = await store.insert({
      streamId: A,
      author: agent(B),
      toAgentId: A,
      text: "review",
      delivered: true,
    });
    await store.insert({
      streamId: A,
      author: agent(A),
      threadId: root.id,
      replyTo: root.id,
      text: "fixed",
    });
    await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "thanks",
    });
    await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "again",
    });
    const sortKey = (a: BlockAuthor) =>
      a.kind === "user" ? "user" : `agent:${a.agentId}`;
    const byKey = (list: BlockAuthor[]) => list.map(sortKey).sort();
    expect(byKey(await store.threadParticipants(root.id, USER))).toEqual([
      `agent:${A}`,
      `agent:${B}`,
    ]);
    expect(byKey(await store.threadParticipants(root.id, agent(A)))).toEqual([
      `agent:${B}`,
      "user",
    ]);
    expect(await store.threadParticipants(NIL, USER)).toEqual([]);
  });
});
