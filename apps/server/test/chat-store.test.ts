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

  it("lists newest-first pages returned oldest-first with hasMore", async () => {
    const ids = await seed(A, 5, "agent");
    await seed(B, 2, "agent");

    const page1 = await store.list(A, { limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);

    const page2 = await store.list(A, {
      before: page1.messages[0].createdAt,
      limit: 2,
    });
    expect(page2.hasMore).toBe(true);
    expect(page2.messages.map((m) => m.id)).toEqual([ids[1], ids[2]]);

    const page3 = await store.list(A, {
      before: page2.messages[0].createdAt,
      limit: 2,
    });
    expect(page3.hasMore).toBe(false);
    expect(page3.messages.map((m) => m.id)).toEqual([ids[0]]);

    const all = await store.list(A, { limit: 50 });
    expect(all.hasMore).toBe(false);
    expect(all.messages).toHaveLength(5);
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
