import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  clampFeedLimit,
  composeChatFeed,
  decodeFeedCursor,
  encodeFeedCursor,
} from "../src/chat/feed.js";
import { ChatStore } from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: ChatStore;

const A = "agt_feed_a";
const OTHER = "agt_feed_other";
const ARCHIVED_CHILD = "agt_feed_archived_child";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new ChatStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, parent_agent_id, deleted_at)
     VALUES ($1, 'Feed A', '/tmp', 'running', NULL, NULL),
            ($2, 'Other', '/tmp', 'running', NULL, NULL),
            ($3, 'Archived child', '/tmp', 'stopped', $1, NOW())`,
    [A, OTHER, ARCHIVED_CHILD]
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
  await pool.query("DELETE FROM reviews");
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
    const feed = await composeChatFeed(store, A);
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

  it("pages backwards with cursor/limit and reports hasMore across sources", async () => {
    await seedAll();
    const page1 = await composeChatFeed(store, A, { limit: 3 });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.entries.map((e) => e.at)).toEqual(
      [5, 6, 7].map((s) => at(s).toISOString())
    );

    const page2 = await composeChatFeed(store, A, {
      limit: 3,
      cursor: decodeFeedCursor(page1.nextCursor!),
    });
    expect(page2.hasMore).toBe(true);
    expect(page2.entries.map((e) => e.at)).toEqual(
      [2, 3, 4].map((s) => at(s).toISOString())
    );

    const page3 = await composeChatFeed(store, A, {
      limit: 3,
      cursor: decodeFeedCursor(page2.nextCursor!),
    });
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
    expect(page3.entries.map((e) => e.type)).toEqual(["status"]);
  });

  it("marks both directions of archived child conversations", async () => {
    await pool.query(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
          content, delivered, created_at)
       VALUES (gen_random_uuid(), $2, $1, 'Archived child', 'Feed A', 'in', true, $3),
              (gen_random_uuid(), $1, $2, 'Feed A', 'Archived child', 'out', true, $4),
              (gen_random_uuid(), $5, $1, 'Other', 'Feed A', 'peer', true, $4)`,
      [A, ARCHIVED_CHILD, at(10), at(11), OTHER]
    );

    const messages = (await composeChatFeed(store, A)).entries.filter(
      (entry) => entry.type === "agent_message"
    );
    expect(messages).toHaveLength(3);
    expect(
      messages
        .map((entry) => [entry.content, entry.involvesChildAgent])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
    ).toEqual([
      ["in", true],
      ["out", true],
      ["peer", false],
    ]);
  });

  it("never drops or repeats rows that share a timestamp across sources", async () => {
    // Twelve rows at the same instant (three per source kind) with
    // microsecond-identical created_at, paged two at a time.
    const t = at(10);
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO reviews (agent_id, reviewer_type, summary, created_at)
         VALUES ($1, 'human', $2, $3)`,
        [A, `review ${i}`, t]
      );
      await pool.query(
        `INSERT INTO agent_events (agent_id, event_type, message, created_at)
         VALUES ($1, 'working', $2, $3)`,
        [A, `ev${i}`, t]
      );
      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
         VALUES ($1, $2, 'screenshot', 1, $3)`,
        [A, `f${i}.png`, t]
      );
      const m = await store.insert({
        agentId: A,
        authorKind: "agent",
        text: `c${i}`,
      });
      await pool.query(
        `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
        [m.id, t]
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await composeChatFeed(store, A, {
        limit: 2,
        cursor: cursor ? decodeFeedCursor(cursor) : null,
      });
      pages += 1;
      seen.push(...page.entries.map((e) => e.id));
      expect(page.entries.length).toBeLessThanOrEqual(2);
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      cursor = page.nextCursor;
      expect(cursor).toBeTruthy();
      expect(pages).toBeLessThan(20);
    }
    expect(new Set(seen).size).toBe(12);
    expect(seen).toHaveLength(12);
    expect(pages).toBe(6);
  });

  it("round-trips cursors and rejects foreign ones", () => {
    const uuid = "6b6a3e1e-7d1f-4f7b-9a5b-1c2d3e4f5a6b";
    const cursor = {
      at: "2026-01-01 00:00:00.000123",
      type: "chat" as const,
      id: uuid,
    };
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
    const forged = (value: unknown) =>
      decodeFeedCursor(
        Buffer.from(JSON.stringify(value)).toString("base64url")
      );
    expect(decodeFeedCursor("not-a-cursor")).toBeNull();
    expect(forged({})).toBeNull();
    expect(forged({ ...cursor, at: "2026-01-01T00:00:00.000Z" })).toBeNull();
    expect(forged({ ...cursor, type: "pin" })).toBeNull();
    // Ids must fit the source column: uuid for chat/agent_message, a
    // serial for status/media — otherwise the SQL cast would 500.
    expect(forged({ ...cursor, id: "x" })).toBeNull();
    expect(forged({ ...cursor, type: "agent_message", id: "12" })).toBeNull();
    expect(forged({ ...cursor, type: "status", id: uuid })).toBeNull();
    expect(forged({ ...cursor, type: "status", id: "-1" })).toBeNull();
    expect(forged({ ...cursor, type: "status", id: "99999999999" })).toBeNull();
    expect(forged({ ...cursor, type: "status", id: "12" })).toEqual({
      ...cursor,
      type: "status",
      id: "12",
    });
    expect(forged({ ...cursor, type: "media", id: "7" })).toMatchObject({
      id: "7",
    });
    expect(forged({ ...cursor, type: "review", id: "7" })).toMatchObject({
      id: "7",
    });
    expect(forged({ ...cursor, type: "review", id: uuid })).toBeNull();
    // Shape-valid but impossible instants.
    expect(forged({ ...cursor, at: "2026-02-30 00:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-01-01 25:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-13-01 00:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-01-01 00:60:00.000000" })).toBeNull();
    // Year zero parses in JS but is not a Postgres timestamp.
    expect(forged({ ...cursor, at: "0000-01-01 00:00:00.000000" })).toBeNull();
    expect(
      forged({ ...cursor, at: "0001-01-01 00:00:00.000000" })
    ).toMatchObject({ at: "0001-01-01 00:00:00.000000" });
  });

  it("omits a shared file that a post already attaches", async () => {
    const media = await pool.query<{ id: number }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
       VALUES ($1, 'shared-and-attached.png', 'screenshot', 9, $2),
              ($1, 'shared-only.png', 'screenshot', 9, $2)
       RETURNING id`,
      [A, at(60)]
    );
    const attachedId = media.rows[0]!.id;
    await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "reply",
      text: "Here it is.",
      attachments: [
        {
          type: "file",
          mediaId: attachedId,
          fileName: "shared-and-attached.png",
          sizeBytes: 9,
        },
      ],
    });

    const feed = await composeChatFeed(store, A, { limit: 50 });
    const names = feed.entries
      .filter((e) => e.type === "media")
      .map((e) => (e.type === "media" ? e.fileName : ""));
    // The attachment is the richer rendering; the standalone entry would
    // repeat the same file in the same feed.
    expect(names).not.toContain("shared-and-attached.png");
    expect(names).toContain("shared-only.png");
  });

  it("omits composer uploads (source user) that render as post attachments", async () => {
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
       VALUES ($1, 'from-composer.png', 'user', 5, $2),
              ($1, 'from-agent.png', 'screenshot', 5, $2)`,
      [A, at(50)]
    );
    const feed = await composeChatFeed(store, A, { limit: 50 });
    const names = feed.entries
      .filter((e) => e.type === "media")
      .map((e) => (e.type === "media" ? e.fileName : ""));
    expect(names).toContain("from-agent.png");
    expect(names).not.toContain("from-composer.png");
  });

  describe("attachment dimensions", () => {
    async function postWithAttachment(
      fileName: string,
      snapshot: { width?: number; height?: number }
    ): Promise<number> {
      const media = await pool.query<{ id: number }>(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at,
                            width, height)
         VALUES ($1, $2, 'screenshot', 9, $3, 120, 90)
         RETURNING id`,
        [A, fileName, at(60)]
      );
      const mediaId = media.rows[0]!.id;
      await store.insert({
        agentId: A,
        authorKind: "agent",
        kind: "reply",
        text: "Here it is.",
        attachments: [
          { type: "file", mediaId, fileName, sizeBytes: 9, ...snapshot },
        ],
      });
      return mediaId;
    }

    const attachmentOf = (feed: { entries: unknown[] }) => {
      const entry = (feed.entries as Array<{ type: string; message?: unknown }>)
        .filter((e) => e.type === "chat")
        .pop() as { message: { attachments: Array<Record<string, unknown>> } };
      return entry.message.attachments[0]!;
    };

    it("fills in dimensions a pre-column post never stored", async () => {
      await postWithAttachment("old-post.png", {});
      const feed = await composeChatFeed(store, A, { limit: 50 });
      expect(attachmentOf(feed)).toMatchObject({ width: 120, height: 90 });
    });

    it("replaces a snapshot the media row has since moved past", async () => {
      // dispatch_share_file can swap a file's bytes in place, and the post
      // serves the new ones from an unchanged URL. Rendering them against the
      // old ratio would reserve a box the image does not fit.
      const mediaId = await postWithAttachment("replaced.png", {
        width: 120,
        height: 90,
      });
      await pool.query(
        `UPDATE media SET width = 90, height = 120 WHERE id = $1`,
        [mediaId]
      );

      const feed = await composeChatFeed(store, A, { limit: 50 });
      expect(attachmentOf(feed)).toMatchObject({ width: 90, height: 120 });
    });

    it("drops a snapshot when the media row no longer has dimensions", async () => {
      const mediaId = await postWithAttachment("unreadable-now.png", {
        width: 120,
        height: 90,
      });
      await pool.query(
        `UPDATE media SET width = NULL, height = NULL WHERE id = $1`,
        [mediaId]
      );

      const feed = await composeChatFeed(store, A, { limit: 50 });
      const attachment = attachmentOf(feed);
      // Absent, not stale: the fixed-height fallback is the honest render.
      expect(attachment.width).toBeUndefined();
      expect(attachment.height).toBeUndefined();
    });

    it("keeps the snapshot when the media row is gone", async () => {
      const mediaId = await postWithAttachment("deleted.png", {
        width: 120,
        height: 90,
      });
      await pool.query(`DELETE FROM media WHERE id = $1`, [mediaId]);

      const feed = await composeChatFeed(store, A, { limit: 50 });
      // Nothing left to look up, so the snapshot is all there is.
      expect(attachmentOf(feed)).toMatchObject({ width: 120, height: 90 });
    });
  });

  it("surfaces a review with its reviewer and live counts", async () => {
    const reviewer = "agt_feed_reviewer";
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, persona)
       VALUES ($1, 'Reviewer', '/tmp', 'stopped', 'backend-security')
       ON CONFLICT (id) DO NOTHING`,
      [reviewer]
    );
    const review = await pool.query<{ id: number }>(
      `INSERT INTO reviews
         (agent_id, reviewer_type, reviewer_agent_id, summary, status, created_at)
       VALUES ($1, 'agent', $2, 'Two things to fix', 'partially_resolved', $3)
       RETURNING id`,
      [A, reviewer, at(3)]
    );
    const reviewId = review.rows[0]!.id;
    await pool.query(
      `INSERT INTO review_feedback_items (review_id, status)
       VALUES ($1, 'resolved'), ($1, 'open')`,
      [reviewId]
    );
    // Another agent's review must not reach this feed.
    await pool.query(
      `INSERT INTO reviews (agent_id, reviewer_type, summary, created_at)
       VALUES ($1, 'human', 'not mine', $2)`,
      [OTHER, at(4)]
    );

    const feed = await composeChatFeed(store, A);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toEqual({
      type: "review",
      id: `review:${reviewId}`,
      reviewId,
      reviewerType: "agent",
      reviewerAgentId: reviewer,
      reviewerName: "backend-security",
      summary: "Two things to fix",
      status: "partially_resolved",
      itemCount: 2,
      resolvedCount: 1,
      at: at(3).toISOString(),
    });
  });

  it("surfaces a human review with no feedback items", async () => {
    await pool.query(
      `INSERT INTO reviews (agent_id, reviewer_type, summary, status, created_at)
       VALUES ($1, 'human', 'Looks good', 'resolved', $2)`,
      [A, at(2)]
    );
    const feed = await composeChatFeed(store, A);
    expect(feed.entries[0]).toMatchObject({
      type: "review",
      reviewerType: "human",
      reviewerAgentId: null,
      reviewerName: null,
      itemCount: 0,
      resolvedCount: 0,
      status: "resolved",
    });
  });

  it("returns an empty feed for an agent with nothing", async () => {
    const feed = await composeChatFeed(store, "agt_feed_nobody");
    expect(feed).toEqual({
      entries: [],
      hasMore: false,
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it("clamps the limit to the documented range", () => {
    expect(clampFeedLimit(undefined)).toBe(200);
    expect(clampFeedLimit(Number.NaN)).toBe(200);
    expect(clampFeedLimit(0)).toBe(1);
    expect(clampFeedLimit(9999)).toBe(500);
    expect(clampFeedLimit(42.7)).toBe(42);
  });
});
