import type {
  ChatPinEntry,
  ChatReviewEntry,
  ChatStatusEntry,
  StreamBlockEntry,
  StreamEntry,
  StreamFeedResponse,
} from "@dispatch/shared";

import {
  AT_KEY_SQL,
  clampFeedLimit,
  compareNewestFirst,
  cursorClause,
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedCursor,
  intKey,
  type Keyed,
} from "./feed-cursor.js";
import { agentTree } from "../agents/tree.js";
import { listTurnEntries, TURN_PROMPT_CHAT_ID_PATH } from "./turns.js";
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
 * are read through the thread route; a block that opened a turn is rendered
 * by that turn entry (prompt text and attachments included), so listing it
 * again would show the prompt twice.
 *
 * The page is materialized first, then its attachments are expanded once,
 * joined to `media` for live image dimensions, and re-aggregated — one
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
          ${scope}
          AND NOT EXISTS (
            SELECT 1
              FROM agent_stream_events s
             WHERE s.agent_id = $1
               AND s.kind = 'turn'
               AND s.${TURN_PROMPT_CHAT_ID_PATH} = b.id::text
          ) ${clause}
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
         LEFT JOIN media md
           ON md.id = CASE
                        WHEN t.a->>'type' = 'file'
                             AND jsonb_typeof(t.a->'mediaId') = 'number'
                        THEN (t.a->>'mediaId')::int
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
       SELECT c.thread_id, COUNT(*)::int AS reply_count, MAX(c.created_at) AS last_reply_at
         FROM page p
         JOIN blocks c ON c.thread_id = p.id
        GROUP BY c.thread_id
     )
     SELECT ${PAGE_COLUMNS_SQL},
            p.at_key,
            COALESCE(live.attachments, '[]'::jsonb) AS attachments,
            rx.reactions,
            COALESCE(replies.reply_count, 0) AS reply_count,
            replies.last_reply_at
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
  return found?.entry ?? null;
}

async function listStatusEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatStatusEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("status", "int", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: number;
    event_type: string;
    message: string;
    metadata: Record<string, unknown> | null;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, event_type, message, metadata, created_at, ${AT_KEY_SQL} AS at_key
       FROM agent_events
      WHERE agent_id = $1 ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: toStatusEntry(
      row.id,
      row.event_type,
      row.message,
      row.created_at,
      row.metadata
    ),
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
}

/** The feed's shape for one `agent_events` row; also what `stream.entry` carries. */
export function toStatusEntry(
  id: number,
  eventType: string,
  message: string,
  createdAt: Date | string,
  metadata?: Record<string, unknown> | null
): ChatStatusEntry {
  const system = metadata?.source === "system";
  const phase = typeof metadata?.phase === "string" ? metadata.phase : null;
  const setupPhase =
    typeof metadata?.setupPhase === "string" ? metadata.setupPhase : null;
  return {
    type: "status",
    id: `event:${id}`,
    eventType,
    message,
    at: new Date(createdAt).toISOString(),
    ...(system ? { system: true } : {}),
    ...(phase ? { phase } : {}),
    ...(setupPhase ? { setupPhase } : {}),
  };
}

/**
 * Reviews left on this agent's work. Counts and status are read live rather
 * than frozen at submission time, so the card in the feed says the same
 * thing as the row in the Reviews sidebar it links to.
 */
async function listReviewEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatReviewEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("review", "int", cursor, params, "r");
  params.push(limit);
  const result = await db.query<{
    id: number;
    reviewer_type: string;
    reviewer_agent_id: string | null;
    reviewer_name: string | null;
    summary: string | null;
    status: string;
    item_count: number;
    resolved_count: number;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT r.id, r.reviewer_type, r.reviewer_agent_id, r.summary, r.status,
            r.created_at,
            COALESCE(reviewer.persona, reviewer.name) AS reviewer_name,
            COUNT(fi.id)::int AS item_count,
            COUNT(fi.id) FILTER (WHERE fi.status = 'resolved')::int
              AS resolved_count,
            to_char(r.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD HH24:MI:SS.US') AS at_key
       FROM reviews r
       LEFT JOIN agents reviewer ON reviewer.id = r.reviewer_agent_id
       LEFT JOIN review_feedback_items fi ON fi.review_id = r.id
      WHERE r.agent_id = $1 ${clause}
      GROUP BY r.id, reviewer.persona, reviewer.name
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: {
      type: "review",
      id: `review:${row.id}`,
      reviewId: row.id,
      reviewerType: row.reviewer_type === "agent" ? "agent" : "human",
      reviewerAgentId: row.reviewer_agent_id,
      reviewerName: row.reviewer_name,
      summary: row.summary,
      status: row.status,
      itemCount: row.item_count,
      resolvedCount: row.resolved_count,
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
}

/**
 * Pin activity, one entry per write: every row of a batch write shares the
 * transaction's `now()`, so grouping by (created_at, action) turns "replace
 * group Build with five pins" into one post rather than five.
 */
async function listPinEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatPinEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("pin", "int", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: number;
    action: ChatPinEntry["action"];
    pin_ids: string[];
    labels: string[];
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, action, pin_ids, labels, created_at, ${AT_KEY_SQL} AS at_key
       FROM (
         SELECT min(id) AS id, action, created_at,
                array_agg(pin_id ORDER BY id) AS pin_ids,
                array_agg(label ORDER BY id) AS labels
           FROM pin_events
          WHERE agent_id = $1
          GROUP BY created_at, action
       ) AS writes
      WHERE TRUE ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: {
      type: "pin",
      id: `pin:${row.id}`,
      action: row.action,
      pins: row.pin_ids.map((id, i) => ({ id, label: row.labels[i] ?? "" })),
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
}

/**
 * Compose one stream's feed at read time from blocks, system status marks,
 * reviews, pin activity, and the turns of every agent in the root's tree
 * (a child's turns show in its parent's stream, folded by the client).
 * Each source contributes its newest `limit + 1` rows past the cursor; the
 * merge keeps the newest `limit` overall, so any row that belongs on the
 * page is present, and anything left over proves an older page exists.
 */
export async function composeStreamFeed(
  store: BlockStore,
  streamId: string,
  opts: ComposeFeedOptions = {}
): Promise<StreamFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const { db } = store;
  const tree = await agentTree(db, streamId);
  const [blocks, status, reviews, turnsByAgent, pins, unreadCount] =
    await Promise.all([
      listBlockEntries(db, streamId, cursor, limit + 1),
      listStatusEntries(db, streamId, cursor, limit + 1),
      listReviewEntries(db, streamId, cursor, limit + 1),
      Promise.all(
        tree.map((agentId) => listTurnEntries(db, agentId, cursor, limit + 1))
      ),
      listPinEntries(db, streamId, cursor, limit + 1),
      store.countUnread(streamId),
    ]);

  const merged: Keyed<StreamEntry>[] = [
    ...blocks,
    ...status,
    ...reviews,
    ...turnsByAgent.flat(),
    ...pins,
  ].sort(compareNewestFirst);
  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
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
