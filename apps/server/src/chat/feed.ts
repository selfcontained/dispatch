import type {
  Block,
  ChatTurnStep,
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
import { agentNamesFor } from "./agent-names.js";
import { attachTurns } from "./turns.js";
import {
  type BlockRow,
  type BlockStore,
  OPEN_INPUT_SQL,
  type Queryable,
  shownIdsOf,
  toBlock,
} from "./store.js";

// The feed's ordering primitives live in `feed-cursor.ts` so the turn
// composer can use them without importing this module back.
export { clampFeedLimit, decodeFeedCursor, encodeFeedCursor };

export type ComposeFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
  /** Whether an agent is mid-turn, for the `held` delivery state. */
  isHeld?: (agentId: string) => boolean;
  /** Development comparison only: retain full settled step details. */
  compactTurns?: boolean;
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
  "deliveries",
  "steering_receipts",
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
 * joined to `files` for each file's live type and image dimensions, and
 * re-aggregated — one function scan and a hash join for the planner to price
 * instead of a per-row lookup it would estimate at a hundred index scans.
 */
async function listBlockEntries(
  db: Queryable,
  streamId: string,
  cursor: FeedCursor | null,
  limit: number,
  onlyIds?: readonly string[]
): Promise<Keyed<StreamBlockEntry>[]> {
  const params: unknown[] = [streamId];
  let clause = cursorClause("block", "uuid", cursor, params, "b");
  // A page lists top-level blocks only; a read by id may name a reply (or
  // a block another one shows), which is published as its own entry so a
  // client can file it into its thread.
  let scope = "AND b.thread_id IS NULL";
  if (onlyIds !== undefined) {
    params.push([...onlyIds]);
    clause += ` AND b.id = ANY($${params.length}::uuid[])`;
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
              (t.a - 'width' - 'height')
                || CASE
                     WHEN md.id IS NOT NULL
                     THEN jsonb_build_object('mimeType', md.mime_type)
                     ELSE '{}'::jsonb
                   END
                || CASE
                     WHEN md.metadata ? 'width' AND md.metadata ? 'height'
                     THEN jsonb_build_object(
                            'width', md.metadata->'width',
                            'height', md.metadata->'height')
                     ELSE '{}'::jsonb
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
                         JOIN blocks host ON host.id = c.thread_id
                        WHERE b.thread_id = c.thread_id
                          AND NOT (COALESCE(host.state->'blocks', '[]'::jsonb) ? b.id::text)
                        GROUP BY b.author_kind, b.author_agent_id) a) AS repliers
         FROM page p
         -- The blocks a host shows are in its thread but are not replies:
         -- the host draws them, so they are not counted.
         JOIN blocks c ON c.thread_id = p.id
          AND NOT (COALESCE(p.state->'blocks', '[]'::jsonb) ? c.id::text)
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
 * The state a stored outcome cannot carry: the agent has the prompt
 * queued behind the turn it is running, so the post is waiting rather
 * than lost. Applied wherever the stream is read, so a reload, a second
 * tab and another device all say the same thing.
 */
export function markHeld(
  blocks: readonly Block[],
  isHeld: (agentId: string) => boolean
): void {
  for (const block of blocks) {
    if (!block.delivery) continue;
    for (const entry of block.delivery) {
      if (entry.state === "pending" && isHeld(entry.agentId)) {
        entry.state = "held";
      }
    }
  }
}

/**
 * One block as the feed would list it, or a reply as its thread lists it.
 * Null when it is not on this stream.
 */
export async function loadBlockEntry(
  db: Queryable,
  streamId: string,
  blockId: string,
  isHeld?: (agentId: string) => boolean
): Promise<StreamBlockEntry | null> {
  const [found] = await listBlockEntries(db, streamId, null, 1, [blockId]);
  if (!found) return null;
  await attachTurns(db, [found.entry.block]);
  await attachShown(db, streamId, [found.entry.block], isHeld);
  if (isHeld) markHeld([found.entry.block], isHeld);
  return found.entry;
}

/** Deeper than any card goes (a launch card shows a review, which shows findings). */
const SHOWN_MAX_DEPTH = 4;

/**
 * A settled turn's edit diffs and tool output can dwarf the rest of a feed
 * page even though its activity is closed. Keep paths for the folded turn
 * label; the detail route returns the full turn when the reader opens it.
 */
export function compactFeedTurnDetails(blocks: readonly Block[]): void {
  const omitStep = (step: ChatTurnStep): boolean => {
    let omitted = false;
    const diff = step.detail.diff;
    if (diff) {
      if (!step.detail.locations?.length) {
        step.detail.locations = [{ path: diff.path }];
      }
      delete step.detail.diff;
      omitted = true;
    }
    if ((step.detail.terminalOutput?.length ?? 0) > 1024) {
      delete step.detail.terminalOutput;
      omitted = true;
    }
    if ((step.detail.text?.length ?? 0) > 1024) {
      delete step.detail.text;
      omitted = true;
    }
    if (
      step.detail.input !== undefined &&
      JSON.stringify(step.detail.input).length > 4096
    ) {
      delete step.detail.input;
      omitted = true;
    }
    for (const child of step.children ?? []) {
      if (omitStep(child)) omitted = true;
    }
    return omitted;
  };
  for (const block of blocks) {
    const turn = block.turn;
    if (turn?.settled) {
      let omitted = false;
      for (const step of turn.trace.steps) {
        if (omitStep(step)) omitted = true;
      }
      if (omitted) turn.trace.detailsOmitted = true;
    }
    if (block.blocks?.length) compactFeedTurnDetails(block.blocks);
  }
}

/**
 * Put the blocks each block shows onto it as `blocks`, read the way the
 * feed reads any row (reactions, thread counts), and theirs onto them in
 * turn. A host is drawn with what it shows, so it has to arrive with it.
 */
export async function attachShown(
  db: Queryable,
  streamId: string,
  blocks: Block[],
  isHeld?: (agentId: string) => boolean,
  depth = 0
): Promise<void> {
  if (depth >= SHOWN_MAX_DEPTH) return;
  const hosts = blocks.filter((block) => shownIdsOf(block).length > 0);
  if (hosts.length === 0) return;
  const ids = [...new Set(hosts.flatMap((host) => shownIdsOf(host)))];
  const rows = await listBlockEntries(db, streamId, null, ids.length, ids);
  const byId = new Map(
    rows.map((row) => [row.entry.block.id, row.entry.block])
  );
  const shown = [...byId.values()];
  await attachTurns(db, shown);
  if (isHeld) markHeld(shown, isHeld);
  await attachShown(db, streamId, shown, isHeld, depth + 1);
  for (const host of hosts) {
    host.blocks = shownIdsOf(host)
      .map((id) => byId.get(id))
      .filter((block): block is Block => block !== undefined);
  }
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
  const [rows, unreadCount] = await Promise.all([
    listBlockEntries(db, streamId, cursor, limit + 1),
    store.countUnread(streamId),
  ]);
  const merged: Keyed<StreamEntry>[] = rows.sort(compareNewestFirst);
  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  const blocks = page.map((item) => item.entry.block);
  const [openInputs, threadLinks] = await Promise.all([
    cursor ? Promise.resolve(null) : listOpenInputs(db, streamId),
    cursor ? Promise.resolve(null) : listThreadLinks(db, streamId),
    attachTurns(db, blocks),
    attachShown(db, streamId, blocks, opts.isHeld),
  ]);
  if (opts.compactTurns !== false) compactFeedTurnDetails(blocks);
  // Names last: the blocks the page shows, and the asks and links it
  // carries, name agents of their own.
  const agentNames = await agentNamesFor(db, [
    ...blocks,
    ...(openInputs ?? []),
    ...(threadLinks ?? []),
  ]);
  if (opts.isHeld) markHeld(blocks, opts.isHeld);
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
    ...(openInputs ? { openInputs } : {}),
    ...(threadLinks ? { threadLinks } : {}),
    agentNames,
  };
}

/** How many posts with links from threads the first page carries: the Inbox's glance. */
const THREAD_LINKS_MAX = 20;

/**
 * The newest posts in threads that carry a link or a pull request: a
 * child's work lands in its own thread, which the feed does not list, and
 * the links it produces are the Inbox's to show.
 */
async function listThreadLinks(
  db: Queryable,
  streamId: string
): Promise<Block[]> {
  const result = await db.query<BlockRow>(
    `SELECT b.* FROM blocks b
      WHERE b.stream_id = $1 AND b.thread_id IS NOT NULL
        AND (b.kind = 'link'
             OR b.attachments @> '[{"type": "link"}]'::jsonb
             OR b.attachments @> '[{"type": "pr"}]'::jsonb)
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ${THREAD_LINKS_MAX}`,
    [streamId]
  );
  return result.rows.map(toBlock);
}

/** How many open asks the first page carries; more would be a stream in trouble. */
const OPEN_INPUTS_MAX = 50;

/**
 * Every question or form an agent has open for people in this stream,
 * wherever it was asked: a child asks in its own thread, which the feed
 * does not list, and an open ask must never be out of sight.
 */
async function listOpenInputs(
  db: Queryable,
  streamId: string
): Promise<Block[]> {
  const result = await db.query<BlockRow>(
    `SELECT b.* FROM blocks b
      WHERE b.stream_id = $1 AND b.author_kind = 'agent'
        AND b.to_agent_id IS NULL AND ${OPEN_INPUT_SQL}
      ORDER BY b.created_at, b.id
      LIMIT ${OPEN_INPUTS_MAX}`,
    [streamId]
  );
  return result.rows.map(toBlock);
}
