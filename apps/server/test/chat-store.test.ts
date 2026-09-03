import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ChatStore } from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: ChatStore;

const A = "agt_chat_a";
const B = "agt_chat_b";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new ChatStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, deleted_at)
     VALUES ($1, 'A', '/tmp', 'running', NULL),
            ($2, 'B', '/tmp', 'running', NULL),
            ('agt_chat_gone', 'Gone', '/tmp', 'stopped', now())`,
    [A, B]
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_chat_messages");
});

async function seed(agentId: string, n: number, authorKind: "agent" | "user") {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await store.insert({ agentId, authorKind, text: `m${i}` });
    // Distinct created_at per row so paging by timestamp is deterministic.
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [m.id, new Date(Date.UTC(2026, 0, 1, 0, 0, i))]
    );
    ids.push(m.id);
  }
  return ids;
}

describe("ChatStore", () => {
  it("inserts with defaults and round-trips the wire shape", async () => {
    const m = await store.insert({
      agentId: A,
      authorKind: "agent",
      text: "hello",
    });
    expect(m).toMatchObject({
      agentId: A,
      authorKind: "agent",
      kind: "reply",
      text: "hello",
      replyTo: null,
      question: null,
      answer: null,
      attachments: [],
      delivered: null,
      readAt: null,
    });
    expect(m.createdAt).toBe(m.updatedAt);
    expect(await store.getById(m.id)).toEqual(m);
    expect(await store.getById("00000000-0000-0000-0000-000000000000")).toBe(
      null
    );
  });

  it("stores origin and launchedByAgentId, and leaves both off the wire otherwise", async () => {
    const plain = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "typed",
    });
    expect("origin" in plain).toBe(false);
    expect("launchedByAgentId" in plain).toBe(false);

    const launch = await store.insert({
      agentId: A,
      authorKind: "user",
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
      agentId: A,
      authorKind: "user",
      text: "Build it",
      origin: "launch",
    });
    expect(own.origin).toBe("launch");
    expect("launchedByAgentId" in own).toBe(false);

    await expect(
      pool.query(
        `INSERT INTO agent_chat_messages (id, agent_id, author_kind, text, origin)
         VALUES (gen_random_uuid(), $1, 'user', 'x', 'typed')`,
        [A]
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it("stores question, attachments, replyTo and delivered", async () => {
    const q = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "Which?",
      question: { options: [{ label: "x" }, { label: "y", value: "Y" }] },
      attachments: [{ type: "link", url: "https://e.com", title: "e" }],
    });
    expect(q.question?.options).toHaveLength(2);
    expect(q.attachments).toEqual([
      { type: "link", url: "https://e.com", title: "e" },
    ]);
    const u = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "x",
      replyTo: q.id,
      delivered: true,
    });
    expect(u.replyTo).toBe(q.id);
    expect(u.delivered).toBe(true);
    await store.setDelivered(u.id, false);
    expect((await store.getById(u.id))?.delivered).toBe(false);
  });

  it("updates only supplied fields and bumps updated_at", async () => {
    const m = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "q",
      question: { options: [{ label: "a" }] },
    });
    const updated = await store.update(m.id, { text: "q2" });
    expect(updated?.text).toBe("q2");
    expect(updated?.question).toEqual({ options: [{ label: "a" }] });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(m.updatedAt)
    );
    const cleared = await store.update(m.id, {
      kind: "reply",
      question: null,
      attachments: [{ type: "code", code: "x" }],
    });
    expect(cleared?.kind).toBe("reply");
    expect(cleared?.question).toBeNull();
    expect(cleared?.attachments).toEqual([{ type: "code", code: "x" }]);
    expect(await store.update(m.id, {})).toEqual(cleared);
    expect(
      await store.update("00000000-0000-0000-0000-000000000000", { text: "x" })
    ).toBeNull();
  });

  it("counts and marks unread agent messages only, optionally up to a message", async () => {
    const ids = await seed(A, 3, "agent");
    await seed(A, 2, "user");
    await seed(B, 1, "agent");
    expect(await store.countUnread(A)).toBe(3);

    expect(await store.markRead(A, ids[1])).toBe(2);
    expect(await store.countUnread(A)).toBe(1);
    expect((await store.getById(ids[2]))?.readAt).toBeNull();
    expect((await store.getById(ids[0]))?.readAt).not.toBeNull();

    // Unknown bound marks nothing.
    expect(
      await store.markRead(A, "00000000-0000-0000-0000-000000000000")
    ).toBe(0);

    expect(await store.markRead(A)).toBe(1);
    expect(await store.countUnread(A)).toBe(0);
    expect(await store.countUnread(B)).toBe(1);
  });

  it("treats malformed ids as not found instead of erroring", async () => {
    expect(await store.getById("nope")).toBeNull();
    expect(await store.update("nope", { text: "x" })).toBeNull();
    expect(await store.markRead(A, "nope")).toBe(0);
    expect(
      await store.recordAnswer("nope", {
        value: "a",
        replyMessageId: "x",
        answeredAt: new Date().toISOString(),
      })
    ).toBeNull();
    await expect(store.setDelivered("nope", true)).resolves.toBeUndefined();
  });

  it("summarises unread and pending questions per live agent", async () => {
    await store.insert({ agentId: A, authorKind: "agent", text: "1" });
    const q = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    await store.insert({ agentId: A, authorKind: "user", text: "ignored" });
    await store.insert({
      agentId: "agt_chat_gone",
      authorKind: "agent",
      text: "x",
    });
    await store.insert({
      agentId: "agt_chat_unknown",
      authorKind: "agent",
      text: "x",
    });
    expect(await store.unreadSummary()).toEqual({
      agents: { [A]: { unread: 2, pendingQuestions: 1 } },
    });

    // Read but still unanswered keeps the agent listed.
    await store.markRead(A);
    expect(await store.unreadSummary()).toEqual({
      agents: { [A]: { unread: 0, pendingQuestions: 1 } },
    });
    await store.recordAnswer(q.id, {
      value: "a",
      replyMessageId: q.id,
      answeredAt: new Date().toISOString(),
    });
    expect(await store.unreadSummary()).toEqual({ agents: {} });
  });

  it("records an answer once", async () => {
    const q = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    const plain = await store.insert({
      agentId: A,
      authorKind: "agent",
      text: "not a question",
    });
    const answer = {
      value: "a",
      label: "a",
      replyMessageId: "00000000-0000-0000-0000-000000000001",
      answeredAt: new Date().toISOString(),
    };
    const first = await store.recordAnswer(q.id, answer);
    expect(first?.answer).toEqual(answer);
    expect(await store.recordAnswer(q.id, answer)).toBeNull();
    expect(await store.recordAnswer(plain.id, answer)).toBeNull();
  });
});

describe("ChatStore.sweepPendingDeliveries", () => {
  it("flips only pending user rows to not-delivered and reports their agents", async () => {
    const pendingA = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "p1",
      delivered: null,
    });
    const pendingA2 = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "p2",
      delivered: null,
    });
    const pendingB = await store.insert({
      agentId: B,
      authorKind: "user",
      text: "p3",
      delivered: null,
    });
    const settled = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "ok",
      delivered: true,
    });
    // Agent rows never carry a delivery state; NULL there means nothing.
    const agentRow = await store.insert({
      agentId: A,
      authorKind: "agent",
      text: "hi",
    });

    const touched = await store.sweepPendingDeliveries();
    expect(touched.sort()).toEqual([A, B].sort());

    for (const id of [pendingA.id, pendingA2.id, pendingB.id]) {
      expect((await store.getById(id))?.delivered).toBe(false);
    }
    expect((await store.getById(settled.id))?.delivered).toBe(true);
    expect((await store.getById(agentRow.id))?.delivered).toBeNull();

    // Idempotent: a second sweep finds nothing.
    expect(await store.sweepPendingDeliveries()).toEqual([]);
  });
});
