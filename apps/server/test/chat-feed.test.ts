import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { clampFeedLimit, composeChatFeed } from "../src/chat/feed.js";
import { ChatStore } from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: ChatStore;

const A = "agt_feed_a";
const OTHER = "agt_feed_other";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new ChatStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status)
     VALUES ($1, 'Feed A', '/tmp', 'running'), ($2, 'Other', '/tmp', 'running')`,
    [A, OTHER]
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_chat_messages");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM agent_messages");
  await pool.query("DELETE FROM media");
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

async function seedAll() {
  // t=1 status, t=2 chat(agent), t=3 media, t=4 agent_message in,
  // t=5 chat(user), t=6 agent_message out, t=7 status
  await pool.query(
    `INSERT INTO agent_events (agent_id, event_type, message, created_at)
     VALUES ($1, 'working', 'reading', $2), ($1, 'done', 'finished', $3),
            ($4, 'working', 'other agent', $2)`,
    [A, at(1), at(7), OTHER]
  );
  const m1 = await store.insert({
    agentId: A,
    authorKind: "agent",
    text: "hi",
  });
  await pool.query(
    `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
    [m1.id, at(2)]
  );
  await pool.query(
    `INSERT INTO media (agent_id, file_name, source, size_bytes, description, created_at)
     VALUES ($1, 'shot.png', 'screenshot', 10, 'a shot', $2)`,
    [A, at(3)]
  );
  await pool.query(
    `INSERT INTO agent_messages
       (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
        content, delivered, created_at)
     VALUES (gen_random_uuid(), $2, $1, 'Other', 'Feed A', 'ping', true, $3),
            (gen_random_uuid(), $1, $2, 'Feed A', 'Other', 'pong', false, $4)`,
    [A, OTHER, at(4), at(6)]
  );
  const m2 = await store.insert({
    agentId: A,
    authorKind: "user",
    text: "hello",
    delivered: true,
  });
  await pool.query(
    `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
    [m2.id, at(5)]
  );
  return { m1, m2 };
}

describe("composeChatFeed", () => {
  it("merges every source for one agent in ascending time order", async () => {
    const { m1, m2 } = await seedAll();
    const feed = await composeChatFeed(pool, A);
    expect(feed.hasMore).toBe(false);
    expect(feed.unreadCount).toBe(1);
    expect(feed.entries.map((e) => e.type)).toEqual([
      "status",
      "chat",
      "media",
      "agent_message",
      "chat",
      "agent_message",
      "status",
    ]);
    expect(feed.entries.map((e) => e.at)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((s) => at(s).toISOString())
    );
    const [status, chat, media, inbound, , outbound] = feed.entries;
    expect(status).toMatchObject({ eventType: "working", message: "reading" });
    expect(chat).toMatchObject({ id: m1.id, message: { text: "hi" } });
    expect(media).toMatchObject({
      fileName: "shot.png",
      sizeBytes: 10,
      description: "a shot",
    });
    expect(inbound).toMatchObject({
      direction: "in",
      senderAgentId: OTHER,
      content: "ping",
      delivered: true,
    });
    expect(outbound).toMatchObject({
      direction: "out",
      recipientAgentId: OTHER,
      content: "pong",
      delivered: false,
    });
    expect(feed.entries[4]).toMatchObject({
      message: { id: m2.id, authorKind: "user", delivered: true },
    });
  });

  it("pages backwards with before/limit and reports hasMore across sources", async () => {
    await seedAll();
    const page1 = await composeChatFeed(pool, A, { limit: 3 });
    expect(page1.hasMore).toBe(true);
    expect(page1.entries.map((e) => e.at)).toEqual(
      [5, 6, 7].map((s) => at(s).toISOString())
    );

    const page2 = await composeChatFeed(pool, A, {
      limit: 3,
      before: page1.entries[0].at,
    });
    expect(page2.hasMore).toBe(true);
    expect(page2.entries.map((e) => e.at)).toEqual(
      [2, 3, 4].map((s) => at(s).toISOString())
    );

    const page3 = await composeChatFeed(pool, A, {
      limit: 3,
      before: page2.entries[0].at,
    });
    expect(page3.hasMore).toBe(false);
    expect(page3.entries.map((e) => e.type)).toEqual(["status"]);
  });

  it("returns an empty feed for an agent with nothing", async () => {
    const feed = await composeChatFeed(pool, "agt_feed_nobody");
    expect(feed).toEqual({ entries: [], hasMore: false, unreadCount: 0 });
  });

  it("clamps the limit to the documented range", () => {
    expect(clampFeedLimit(undefined)).toBe(200);
    expect(clampFeedLimit(Number.NaN)).toBe(200);
    expect(clampFeedLimit(0)).toBe(1);
    expect(clampFeedLimit(9999)).toBe(500);
    expect(clampFeedLimit(42.7)).toBe(42);
  });
});
