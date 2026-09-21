import type {
  StreamBlockEntry,
  StreamEntry,
  StreamFeedResponse,
} from "@dispatch/shared";

import {
  clampFeedLimit,
  compareNewestFirst,
  cursorClause,
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedCursor,
  type Keyed,
} from "./feed-cursor.js";
import { attachTurns } from "./turns.js";
import {
  type BlockRow,
  type BlockStore,
  type Queryable,
  toBlock,
} from "./store.js";

// The feed's ordering primitives live in `feed-cursor.ts` so the turn
// composer can use them without importing this module back.
export { clampFeedLimit, decodeFeedCursor, encodeFeedCursor };

export type ComposeFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
};

/**
 * The block columns `toBlock` needs, minus `attachments` — the query below
 * computes that one rather than passing the stored value through.
 */
const BLOCK_COLUMNS = [
  "id",
  "stream_id",
  "author_kind",
  "author_agent_id",
  "to_agent_id",
  "kind",
  "thread_id",
  "reply_to",
  "text",
  "data",
  "state",
  "origin",
  "launched_by_agent_id",
  "delivered",
  "read_at",
  "created_at",
  "updated_at",
];
const BLOCK_COLUMNS_SQL = BLOCK_COLUMNS.map((c) => `b.${c}`).join(", ");
const PAGE_COLUMNS_SQL = BLOCK_COLUMNS.map((c) => `p.${c}`).join(", ");

/**
 * Top-level blocks on a stream, newest first. Replies live in threads and
 * are read through the thread route.
 *
 * The page is materialized first, then its attachments are expanded once,
 * joined to `files` for live image dimensions, and re-aggregated — one
 * function scan and a hash join for the planner to price instead of a
 * per-row lookup it would estimate at a hundred index scans.
 */
async function listBlockEntries(
  db: Queryable,
  streamId: string,
  cursor: FeedCursor | null,
  limit: number,
  onlyId?: string
): Promise<Keyed<StreamBlockEntry>[]> {
  const params: unknown[] = [streamId];
  let clause = cursorClause("block", "uuid", cursor, params, "b");
  // A page lists top-level blocks only; a single read by id may name a
  // reply, which is published as its own entry so a client can file it
  // into its thread.
  let scope = "AND b.thread_id IS NULL";
  if (onlyId !== undefined) {
    params.push(onlyId);
    clause += ` AND b.id = $${params.length}::uuid`;
    scope = "";
  }
  params.push(limit);
  const result = await db.query<BlockRow & { at_key: string }>(
    `WITH page AS MATERIALIZED (
       SELECT ${BLOCK_COLUMNS_SQL}, b.attachments,
              to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS at_key
         FROM blocks b
        WHERE b.stream_id = $1
          ${scope} ${clause}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $${params.length}
     ), expanded AS (
       SELECT p.id AS block_id, t.ord,
              CASE
                WHEN t.a->>'type' = 'file'
                     AND md.metadata ? 'width'
                     AND md.metadata ? 'height'
                THEN t.a || jsonb_build_object(
                              'width', md.metadata->'width',
                              'height', md.metadata->'height')
                ELSE t.a - 'width' - 'height'
              END AS attachment
         FROM page p
         CROSS JOIN LATERAL
           jsonb_array_elements(p.attachments) WITH ORDINALITY AS t(a, ord)
         LEFT JOIN files md
           ON md.id = CASE
                        WHEN t.a->>'type' = 'file'
                             AND jsonb_typeof(t.a->'fileId') = 'number'
                        THEN (t.a->>'fileId')::int
                      END
     ), live AS (
       SELECT block_id, jsonb_agg(attachment ORDER BY ord) AS attachments
         FROM expanded
        GROUP BY block_id
     ), rx AS (
       SELECT r.block_id,
              jsonb_agg(
                jsonb_build_object(
                  'id', r.id,
                  'authorKind', r.author_kind,
                  'authorAgentId', r.author_agent_id,
                  'emoji', r.emoji,
                  'delivered', r.delivered,
                  'createdAt', r.created_at)
                ORDER BY r.created_at, r.id) AS reactions
         FROM page p
         JOIN block_reactions r ON r.block_id = p.id
        GROUP BY r.block_id
     ), replies AS (
       SELECT c.thread_id,
              COUNT(*)::int AS reply_count,
              MAX(c.created_at) AS last_reply_at,
              -- Agent replies the person has not seen: the thread row's "new".
              COUNT(*) FILTER (WHERE c.author_kind = 'agent' AND c.read_at IS NULL)::int AS unread_replies,
              -- Who has written in the thread, in order of first appearance.
              (SELECT jsonb_agg(jsonb_build_object('kind', a.author_kind, 'agentId', a.author_agent_id)
                                ORDER BY a.first_at)
                 FROM (SELECT b.author_kind, b.author_agent_id, MIN(b.created_at) AS first_at
                         FROM blocks b
                        WHERE b.thread_id = c.thread_id
                        GROUP BY b.author_kind, b.author_agent_id) a) AS repliers
         FROM page p
         JOIN blocks c ON c.thread_id = p.id
        GROUP BY c.thread_id
     )
     SELECT ${PAGE_COLUMNS_SQL},
            p.at_key,
            COALESCE(live.attachments, '[]'::jsonb) AS attachments,
            rx.reactions,
            COALESCE(replies.reply_count, 0) AS reply_count,
            replies.last_reply_at,
            COALESCE(replies.unread_replies, 0) AS unread_replies,
            replies.repliers
       FROM page p
       LEFT JOIN live ON live.block_id = p.id
       LEFT JOIN rx ON rx.block_id = p.id
       LEFT JOIN replies ON replies.thread_id = p.id`,
    params
  );
  return result.rows.map((row) => {
    const block = toBlock(row);
    return {
      entry: { type: "block", id: block.id, at: block.createdAt, block },
      atKey: row.at_key,
      rawId: block.id,
      idKey: block.id,
    };
  });
}

/**
 * One block as the feed would list it, or a reply as its thread lists it.
 * Null when it is not on this stream.
 */
export async function loadBlockEntry(
  db: Queryable,
  streamId: string,
  blockId: string
): Promise<StreamBlockEntry | null> {
  const [found] = await listBlockEntries(db, streamId, null, 1, blockId);
  if (!found) return null;
  await attachTurns(db, [found.entry.block]);
  return found.entry;
}

/**
 * Compose one stream's feed at read time: its top-level blocks, newest
 * first, each turn block carrying its turn. The stream is blocks only; a
 * child's turn is a block of the child's in the parent's stream, folded by
 * the client.
 */
export async function composeStreamFeed(
  store: BlockStore,
  streamId: string,
  opts: ComposeFeedOptions = {}
): Promise<StreamFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const { db } = store;
  const [blocks, unreadCount] = await Promise.all([
    listBlockEntries(db, streamId, cursor, limit + 1),
    store.countUnread(streamId),
  ]);
  const merged: Keyed<StreamEntry>[] = blocks.sort(compareNewestFirst);
  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  await attachTurns(
    db,
    page.map((item) => item.entry.block)
  );
  const oldest = page[page.length - 1];
  const nextCursor =
    hasMore && oldest
      ? encodeFeedCursor({
          at: oldest.atKey,
          type: oldest.entry.type,
          id: oldest.rawId,
        })
      : null;
  return {
    entries: page.reverse().map((item) => item.entry),
    hasMore,
    nextCursor,
    unreadCount,
  };
}
