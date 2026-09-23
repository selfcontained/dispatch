import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { BlockAuthor, StreamBlockEntry } from "@dispatch/shared";

import {
  clampFeedLimit,
  composeStreamFeed,
  decodeFeedCursor,
  encodeFeedCursor,
  loadBlockEntry,
} from "../src/chat/feed.js";
import { BlockStore } from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: BlockStore;

const A = "agt_feed_a";
const OTHER = "agt_feed_other";
const ARCHIVED_CHILD = "agt_feed_archived_child";
const USER: BlockAuthor = { kind: "user" };
const agent = (agentId: string): BlockAuthor => ({ kind: "agent", agentId });

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new BlockStore(pool);
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
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM agent_stream_events");
  await pool.query("DELETE FROM files");
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

async function stamp(id: string, when: Date): Promise<void> {
  await pool.query(`UPDATE blocks SET created_at = $2 WHERE id = $1`, [
    id,
    when,
  ]);
}

const blockEntries = (feed: { entries: unknown[] }) =>
  feed.entries.filter(
    (e): e is StreamBlockEntry => (e as { type: string }).type === "block"
  );

async function seedAll() {
  const m1 = await store.insert({ streamId: A, author: agent(A), text: "hi" });
  await stamp(m1.id, at(2));
  const m3 = await store.insert({
    streamId: A,
    author: agent(A),
    text: "Looks good",
  });
  await stamp(m3.id, at(3));
  const m2 = await store.insert({
    streamId: A,
    author: USER,
    toAgentId: A,
    text: "hello",
    delivered: true,
  });
  await stamp(m2.id, at(5));
  return { m1, m2, m3 };
}

describe("composeStreamFeed", () => {
  it("lists the stream's blocks in ascending time order, and nothing else", async () => {
    const { m1, m2, m3 } = await seedAll();
    const feed = await composeStreamFeed(store, A);
    expect(feed.hasMore).toBe(false);
    expect(feed.unreadCount).toBe(2);
    expect(feed.entries.map((e) => e.type)).toEqual([
      "block",
      "block",
      "block",
    ]);
    expect(feed.entries.map((e) => e.at)).toEqual(
      [2, 3, 5].map((s) => at(s).toISOString())
    );
    const [block, second, userBlock] = feed.entries;
    expect(block).toEqual({
      type: "block",
      id: m1.id,
      at: at(2).toISOString(),
      block: {
        ...m1,
        createdAt: at(2).toISOString(),
        replyCount: 0,
        lastReplyAt: null,
        unreadReplies: 0,
        repliers: [],
      },
    });
    expect(second).toMatchObject({ type: "block", id: m3.id });
    expect(userBlock).toMatchObject({
      block: {
        id: m2.id,
        author: { kind: "user" },
        toAgentId: A,
        delivered: true,
      },
    });
  });

  it("pages backwards with cursor/limit and reports hasMore", async () => {
    await seedAll();
    const page1 = await composeStreamFeed(store, A, { limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.entries.map((e) => e.at)).toEqual(
      [3, 5].map((s) => at(s).toISOString())
    );

    const page2 = await composeStreamFeed(store, A, {
      limit: 2,
      cursor: decodeFeedCursor(page1.nextCursor!),
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    expect(page2.entries.map((e) => e.at)).toEqual([at(2).toISOString()]);
  });

  it("never drops or repeats rows that share a timestamp", async () => {
    // Six blocks at the same instant with microsecond-identical
    // created_at, paged two at a time.
    const t = at(10);
    for (let i = 0; i < 3; i++) {
      const extra = await store.insert({
        streamId: A,
        author: agent(A),
        text: `b${i}`,
      });
      await stamp(extra.id, t);
      const b = await store.insert({
        streamId: A,
        author: agent(A),
        text: `c${i}`,
      });
      await stamp(b.id, t);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await composeStreamFeed(store, A, {
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
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
    expect(pages).toBe(3);
  });

  it("round-trips cursors and rejects foreign ones", () => {
    const uuid = "6b6a3e1e-7d1f-4f7b-9a5b-1c2d3e4f5a6b";
    const cursor = {
      at: "2026-01-01 00:00:00.000123",
      type: "block" as const,
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
    // The retired sources are not cursor types any more.
    expect(forged({ ...cursor, type: "chat" })).toBeNull();
    expect(forged({ ...cursor, type: "file", id: "7" })).toBeNull();
    // Ids must fit the source column (uuid for block), otherwise the SQL
    // cast would 500. The stream is blocks only: the sources that once had
    // cursors of their own are not cursor types any more.
    expect(forged({ ...cursor, id: "x" })).toBeNull();
    expect(forged({ ...cursor, type: "block", id: "12" })).toBeNull();
    expect(forged({ ...cursor, type: "status", id: "12" })).toBeNull();
    expect(forged({ ...cursor, type: "turn", id: "7" })).toBeNull();
    // Shape-valid but impossible instants.
    expect(forged({ ...cursor, at: "2026-02-30 00:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-01-01 25:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-13-01 00:00:00.000000" })).toBeNull();
    expect(forged({ ...cursor, at: "2026-01-01 00:60:00.000000" })).toBeNull();
    // Year zero parses in JS but is not a Postgres timestamp.
    expect(forged({ ...cursor, at: "0000-01-01 00:00:00.000000" })).toBeNull();
    expect(
      forged({ ...cursor, at: "0001-01-01 00:00:00.000000" })
    ).toMatchObject({
      at: "0001-01-01 00:00:00.000000",
    });
  });

  it("lists top-level blocks only, with each thread's reply count and last reply time", async () => {
    const root = await store.insert({
      streamId: A,
      author: agent(A),
      text: "root",
    });
    await stamp(root.id, at(1));
    const r1 = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "r1",
      delivered: true,
    });
    await stamp(r1.id, at(2));
    const r2 = await store.insert({
      streamId: A,
      author: agent(A),
      threadId: root.id,
      replyTo: r1.id,
      text: "r2",
    });
    await stamp(r2.id, at(4));
    const lone = await store.insert({
      streamId: A,
      author: agent(A),
      text: "lone",
    });
    await stamp(lone.id, at(3));

    const feed = await composeStreamFeed(store, A);
    expect(feed.entries.map((e) => e.id)).toEqual([root.id, lone.id]);
    const [rootEntry, loneEntry] = blockEntries(feed);
    expect(rootEntry.block).toMatchObject({
      replyCount: 2,
      lastReplyAt: at(4).toISOString(),
      // The person first, then the agent: order of first appearance. The
      // agent's reply is unread; the person's own never counts.
      repliers: [{ kind: "user" }, { kind: "agent", agentId: A }],
      unreadReplies: 1,
    });
    expect(loneEntry.block).toMatchObject({
      replyCount: 0,
      lastReplyAt: null,
      repliers: [],
      unreadReplies: 0,
    });
    // Replies are not unread rows of their own in the feed, but they do
    // count toward unread: an agent reply for people is still unread.
    expect(feed.unreadCount).toBe(3);
  });

  it("carries a block's reactions, oldest first, and omits the key when there are none", async () => {
    const b = await store.insert({ streamId: A, author: agent(A), text: "x" });
    const plain = await store.insert({
      streamId: A,
      author: agent(A),
      text: "y",
    });
    const first = await store.insertReaction({
      streamId: A,
      blockId: b.id,
      author: USER,
      emoji: "👍",
      delivered: true,
    });
    await pool.query(
      `UPDATE block_reactions SET created_at = $2 WHERE id = $1`,
      [first!.id, at(1)]
    );
    const second = await store.insertReaction({
      streamId: A,
      blockId: b.id,
      author: agent(A),
      emoji: "🎉",
      delivered: null,
    });
    await pool.query(
      `UPDATE block_reactions SET created_at = $2 WHERE id = $1`,
      [second!.id, at(2)]
    );
    const feed = await composeStreamFeed(store, A);
    const entry = blockEntries(feed).find((e) => e.id === b.id)!;
    expect(entry.block.reactions).toEqual([
      {
        id: first!.id,
        author: { kind: "user" },
        emoji: "👍",
        delivered: true,
        createdAt: at(1).toISOString(),
      },
      {
        id: second!.id,
        author: { kind: "agent", agentId: A },
        emoji: "🎉",
        delivered: null,
        createdAt: at(2).toISOString(),
      },
    ]);
    const plainEntry = blockEntries(feed).find((e) => e.id === plain.id)!;
    expect("reactions" in plainEntry.block).toBe(false);
  });

  it("a turn is a block: the feed lists it with its turn attached, after its prompt", async () => {
    const prompt = await store.insert({
      streamId: A,
      author: USER,
      toAgentId: A,
      text: "Fix the bug",
      delivered: true,
    });
    await stamp(prompt.id, at(1));
    const turnRow = await pool.query<{ id: string }>(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload, created_at, updated_at)
       VALUES ($1, 1, 'turn', $2::jsonb, $3, $3) RETURNING id`,
      [
        A,
        JSON.stringify({
          state: "settled",
          stopReason: "end_turn",
          prompt: { source: "chat", chatMessageId: prompt.id },
          endedAt: at(3).toISOString(),
        }),
        at(2),
      ]
    );
    const eventId = Number(turnRow.rows[0]!.id);
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload, created_at, updated_at)
       VALUES ($1, 2, 'assistant', $2::jsonb, $3, $3)`,
      [A, JSON.stringify({ text: "Fixed it.", streaming: false }), at(3)]
    );
    const answer = await store.insert({
      streamId: A,
      author: agent(A),
      origin: "turn",
      data: { turnEventId: eventId },
      text: "Fixed it.",
    });
    await stamp(answer.id, at(2));
    const feed = await composeStreamFeed(store, A);
    // The prompt is a row of its own; the answer follows it as a block.
    expect(feed.entries.map((e) => e.type)).toEqual(["block", "block"]);
    expect(feed.entries.map((e) => e.id)).toEqual([prompt.id, answer.id]);
    expect(feed.entries[1]!.block).toMatchObject({
      origin: "turn",
      text: "Fixed it.",
      turn: {
        type: "turn",
        agentId: A,
        settled: true,
        result: { text: "Fixed it." },
        prompt: {
          source: "chat",
          chatMessageId: prompt.id,
          text: "Fix the bug",
        },
        trace: { finalResult: "ok" },
      },
    });
    // One block read back carries its turn too, and the prompt is a row.
    expect(
      (await loadBlockEntry(pool, A, answer.id))?.block.turn
    ).toMatchObject({ settled: true });
    expect(await loadBlockEntry(pool, A, prompt.id)).not.toBeNull();
    // A block that names no turn row of the agent's has no turn.
    const stray = await store.insert({
      streamId: A,
      author: agent(A),
      origin: "turn",
      data: { turnEventId: 999999 },
      text: "",
    });
    expect(
      (await loadBlockEntry(pool, A, stray.id))?.block.turn
    ).toBeUndefined();
  });

  describe("attachment dimensions", () => {
    // Nothing records a shape when the block is written: a re-upload
    // replaces a file's bytes under an unchanged URL, so anything frozen at
    // write time can end up describing bytes the post no longer serves. The
    // live file row is the only source, read when the page is composed.
    async function postWithAttachment(fileName: string): Promise<number> {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, created_at, metadata)
         VALUES ($1, $2, 'screenshot', 9, $3, '{"width":120,"height":90}'::jsonb)
         RETURNING id`,
        [A, fileName, at(60)]
      );
      const fileId = inserted.rows[0]!.id;
      await store.insert({
        streamId: A,
        author: agent(A),
        text: "Here it is.",
        attachments: [{ type: "file", fileId, fileName, sizeBytes: 9 }],
      });
      return fileId;
    }

    const attachmentOf = async () => {
      const feed = await composeStreamFeed(store, A, { limit: 50 });
      const entry = blockEntries(feed).pop()!;
      return entry.block.attachments[0] as Record<string, unknown>;
    };

    it("fills dimensions in from the live file row", async () => {
      await postWithAttachment("posted.png");
      expect(await attachmentOf()).toMatchObject({ width: 120, height: 90 });
    });

    it("follows the row when the file is replaced with another shape", async () => {
      const fileId = await postWithAttachment("replaced.png");
      await pool.query(
        `UPDATE files SET metadata = '{"width":90,"height":120}'::jsonb WHERE id = $1`,
        [fileId]
      );
      expect(await attachmentOf()).toMatchObject({ width: 90, height: 120 });
    });

    it("leaves them off when the row has no dimensions", async () => {
      const fileId = await postWithAttachment("unreadable-now.png");
      await pool.query(
        `UPDATE files SET metadata = '{}'::jsonb WHERE id = $1`,
        [fileId]
      );
      const attachment = await attachmentOf();
      expect(attachment.width).toBeUndefined();
      expect(attachment.height).toBeUndefined();
    });

    it("overrides a stale pair that somehow reached the blob", async () => {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, created_at, metadata)
         VALUES ($1, 'stale.png', 'screenshot', 9, $2, '{"width":90,"height":120}'::jsonb)
         RETURNING id`,
        [A, at(60)]
      );
      await store.insert({
        streamId: A,
        author: agent(A),
        text: "Here it is.",
        attachments: [
          {
            type: "file",
            fileId: inserted.rows[0]!.id,
            fileName: "stale.png",
            sizeBytes: 9,
            width: 1280,
            height: 720,
          },
        ],
      });
      expect(await attachmentOf()).toMatchObject({ width: 90, height: 120 });
    });

    it("strips a stale pair when the row has no dimensions", async () => {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, created_at)
         VALUES ($1, 'unmeasured.png', 'screenshot', 9, $2) RETURNING id`,
        [A, at(60)]
      );
      await store.insert({
        streamId: A,
        author: agent(A),
        text: "Here it is.",
        attachments: [
          {
            type: "file",
            fileId: inserted.rows[0]!.id,
            fileName: "unmeasured.png",
            sizeBytes: 9,
            width: 1280,
            height: 720,
          },
        ],
      });
      const attachment = await attachmentOf();
      expect(attachment.width).toBeUndefined();
      expect(attachment.height).toBeUndefined();
    });

    it("leaves non-file attachments untouched", async () => {
      await store.insert({
        streamId: A,
        author: agent(A),
        text: "Here it is.",
        attachments: [
          { type: "link", url: "https://example.com", title: "Example" },
          { type: "pin", pinId: "pin_1" },
        ],
      });
      const feed = await composeStreamFeed(store, A, { limit: 50 });
      expect(blockEntries(feed).pop()!.block.attachments).toEqual([
        { type: "link", url: "https://example.com", title: "Example" },
        { type: "pin", pinId: "pin_1" },
      ]);
    });

    it("leaves them off when the file row is gone", async () => {
      const fileId = await postWithAttachment("deleted.png");
      await pool.query(`DELETE FROM files WHERE id = $1`, [fileId]);
      const attachment = await attachmentOf();
      expect(attachment.width).toBeUndefined();
      expect(attachment.height).toBeUndefined();
    });
  });

  it("returns an empty feed for a stream with nothing", async () => {
    expect(await composeStreamFeed(store, "agt_feed_nobody")).toEqual({
      entries: [],
      hasMore: false,
      nextCursor: null,
      unreadCount: 0,
      agentNames: {},
    });
  });

  it("names every agent on the page, an archived one included", async () => {
    // The archived child posted to its parent, and was sent a post.
    await store.insert({
      streamId: A,
      author: agent(ARCHIVED_CHILD),
      text: "done; archiving myself",
    });
    await store.insert({
      streamId: A,
      author: agent(A),
      toAgentId: ARCHIVED_CHILD,
      text: "thanks",
      delivered: true,
    });
    const feed = await composeStreamFeed(store, A);
    expect(feed.agentNames).toEqual({
      [A]: "Feed A",
      [ARCHIVED_CHILD]: "Archived child",
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

describe("feed entries as events carry them", () => {
  it("reads one block back exactly as the feed lists it", async () => {
    const { m1, m2 } = await seedAll();
    const feed = await composeStreamFeed(store, A);
    const listed = (id: string) =>
      feed.entries.find((entry) => entry.type === "block" && entry.id === id);
    expect(await loadBlockEntry(pool, A, m1.id)).toEqual(listed(m1.id));
    expect(await loadBlockEntry(pool, A, m2.id)).toEqual(listed(m2.id));
    // Another stream does not hold it; nor does a stream hold nothing.
    expect(await loadBlockEntry(pool, OTHER, m1.id)).toBeNull();
    expect(
      await loadBlockEntry(pool, A, "00000000-0000-4000-8000-000000000000")
    ).toBeNull();
  });

  it("loads a reply as itself, and its root with the count the reply changed", async () => {
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
    });
    // A reply loads as itself (the client files it into its thread); the
    // root, loaded on its own, carries the count the reply changed.
    const entry = await loadBlockEntry(pool, A, reply.id);
    expect(entry).toMatchObject({
      type: "block",
      id: reply.id,
      block: { id: reply.id, threadId: root.id, replyTo: root.id },
    });
    expect(await loadBlockEntry(pool, A, root.id)).toMatchObject({
      id: root.id,
      block: { id: root.id, replyCount: 1, lastReplyAt: reply.createdAt },
    });
    // A reply on another stream resolves to nothing here.
    expect(await loadBlockEntry(pool, OTHER, reply.id)).toBeNull();
  });
});
