import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatMessageEntry,
  ChatPinEntry,
  ChatReviewEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import { dimensionFields, parseMediaMetadata } from "../media/metadata.js";

import {
  AT_KEY_SQL,
  CHAT_FEED_DEFAULT_LIMIT,
  CHAT_FEED_MAX_LIMIT,
  clampFeedLimit,
  compareNewestFirst,
  cursorClause,
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedCursor,
  intKey,
  type Keyed,
} from "./feed-cursor.js";
import { listTurnEntries, TURN_PROMPT_CHAT_ID_PATH } from "./turns.js";
import { type ChatStore, type Queryable, toChatMessage } from "./store.js";

// The feed's ordering primitives live in `feed-cursor.ts` so the turn
// composer can use them without importing this module back.
export {
  CHAT_FEED_DEFAULT_LIMIT,
  CHAT_FEED_MAX_LIMIT,
  clampFeedLimit,
  decodeFeedCursor,
  encodeFeedCursor,
};
export type { FeedCursor };

export type ComposeChatFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
};

/**
 * The message columns `toChatMessage` needs, minus `attachments` — the query
 * below computes that one rather than passing the stored value through, so it
 * cannot be part of a `*`.
 */
const MESSAGE_COLUMNS = [
  "id",
  "agent_id",
  "author_kind",
  "kind",
  "text",
  "reply_to",
  "question",
  "answer",
  "delivered",
  "read_at",
  "origin",
  "launched_by_agent_id",
  "created_at",
  "updated_at",
];
const MESSAGE_COLUMNS_SQL = MESSAGE_COLUMNS.join(", ");
const PAGE_COLUMNS_SQL = MESSAGE_COLUMNS.map((c) => `p.${c}`).join(", ");

async function listChatEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number,
  onlyId?: string
): Promise<Keyed<ChatMessageEntry>[]> {
  const params: unknown[] = [agentId];
  let clause = cursorClause("chat", "uuid", cursor, params);
  if (onlyId !== undefined) {
    params.push(onlyId);
    clause += ` AND m.id = $${params.length}::uuid`;
  }
  params.push(limit);
  // The page is materialized first, then its attachments are expanded once,
  // joined to `media`, and re-aggregated. Doing it that way rather than as a
  // per-row subquery is a planner concern, not a style one: `jsonb_array_elements`
  // has no statistics, so the planner assumes 100 elements per message and
  // prices a per-row lookup at ~100 index scans. On an agent with a long
  // history that estimate carries the whole query past `jit_above_cost` and
  // Postgres JIT-compiles it — measured at 17ms against 2.4ms for this shape,
  // on a page whose actual work is about 1ms either way. Expanding once gives
  // the planner one function scan and a hash join to price instead.
  const result = await db.query<
    Parameters<typeof toChatMessage>[0] & { at_key: string }
  >(
    `WITH page AS MATERIALIZED (
       SELECT ${MESSAGE_COLUMNS_SQL}, attachments, ${AT_KEY_SQL} AS at_key
         FROM agent_chat_messages m
        WHERE m.agent_id = $1
          -- A chat row that opened a turn is rendered by that turn entry,
          -- prompt text and attachments included, so listing it again would
          -- show the prompt twice. Every other chat row stays an entry of
          -- its own: an agent post, a question, an answer. Checked against
          -- every turn row on the agent rather than this page's, so paging
          -- cannot make a prompt reappear.
          AND NOT EXISTS (
            SELECT 1
              FROM agent_stream_events s
             WHERE s.agent_id = $1
               AND s.kind = 'turn'
               AND s.${TURN_PROMPT_CHAT_ID_PATH} = m.id::text
          ) ${clause}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length}
     ), expanded AS (
       SELECT p.id AS message_id, t.ord,
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
       SELECT message_id, jsonb_agg(attachment ORDER BY ord) AS attachments
         FROM expanded
        GROUP BY message_id
     )
     SELECT ${PAGE_COLUMNS_SQL},
            p.at_key,
            COALESCE(live.attachments, '[]'::jsonb) AS attachments
       FROM page p
       LEFT JOIN live ON live.message_id = p.id`,
    params
  );
  return result.rows.map((row) => {
    const message = toChatMessage(row);
    return {
      entry: { type: "chat", id: message.id, at: message.createdAt, message },
      atKey: row.at_key,
      rawId: message.id,
      idKey: message.id,
    };
  });
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
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, event_type, message, created_at, ${AT_KEY_SQL} AS at_key
       FROM agent_events
      WHERE agent_id = $1 ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: toStatusEntry(row.id, row.event_type, row.message, row.created_at),
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
}

/** The feed's shape for one `agent_events` row; also what `chat.entry` carries. */
export function toStatusEntry(
  id: number,
  eventType: string,
  message: string,
  createdAt: Date | string
): ChatStatusEntry {
  return {
    type: "status",
    id: `event:${id}`,
    eventType,
    message,
    at: new Date(createdAt).toISOString(),
  };
}

/**
 * One message as the feed would list it — read back through the feed's own
 * query so the wire copy matches a refetch byte for byte (attachment
 * dimensions included). Null when the row is not on this agent's feed.
 */
export async function loadChatMessageEntry(
  db: Queryable,
  agentId: string,
  messageId: string
): Promise<ChatMessageEntry | null> {
  const [found] = await listChatEntries(db, agentId, null, 1, messageId);
  return found?.entry ?? null;
}

async function listAgentMessageEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatAgentMessageEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("agent_message", "uuid", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: string;
    sender_agent_id: string;
    recipient_agent_id: string;
    sender_name: string;
    recipient_name: string;
    involves_child_agent: boolean;
    content: string;
    delivered: boolean | null;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT m.id, m.sender_agent_id, m.recipient_agent_id, m.sender_name,
            m.recipient_name,
            EXISTS (
              SELECT 1
                FROM agents child
               WHERE child.id IN (m.sender_agent_id, m.recipient_agent_id)
                 AND child.parent_agent_id = $1
            ) AS involves_child_agent,
            m.content, m.delivered, m.created_at,
            ${AT_KEY_SQL} AS at_key
       FROM agent_messages m
      WHERE (m.sender_agent_id = $1 OR m.recipient_agent_id = $1) ${clause}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: {
      type: "agent_message",
      id: row.id,
      direction: row.sender_agent_id === agentId ? "out" : "in",
      senderAgentId: row.sender_agent_id,
      senderName: row.sender_name,
      recipientAgentId: row.recipient_agent_id,
      recipientName: row.recipient_name,
      involvesChildAgent: row.involves_child_agent,
      content: row.content,
      delivered: row.delivered,
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: row.id,
    idKey: row.id,
  }));
}

async function listMediaEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatMediaEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("media", "int", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: number;
    file_name: string;
    size_bytes: number;
    description: string | null;
    metadata: unknown;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, file_name, size_bytes, description, metadata, created_at,
            ${AT_KEY_SQL} AS at_key
       FROM media m
      WHERE m.agent_id = $1
        -- Composer uploads (source 'user') already render as attachments on
        -- the user's own post; listing them again would double them up.
        AND m.source <> 'user'
        -- Same reasoning for a file an agent shared and then attached to a
        -- post: the attachment is the richer rendering, so the standalone
        -- media entry would be a duplicate. Checked against every message on
        -- this agent, not just the ones on this page, so paging can't make a
        -- file reappear.
        AND NOT EXISTS (
          SELECT 1
            FROM agent_chat_messages c
           WHERE c.agent_id = $1
             AND c.attachments @> jsonb_build_array(
                   jsonb_build_object('type', 'file', 'mediaId', m.id)
                 )
        ) ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: {
      type: "media",
      id: `media:${row.id}`,
      mediaId: row.id,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      description: row.description ?? null,
      ...dimensionFields(parseMediaMetadata(row.metadata)),
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
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
 * group Build with five pins" into one post rather than five. The group's
 * smallest id is its id, which keeps the cursor's (created_at, id) tuple
 * comparison exact — no other row shares that timestamp and action.
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
 * Compose one agent's Chat feed at read time from chat messages, status
 * events, cross-agent messages, shared media, reviews, harness turns, and
 * pin activity. Each source contributes its newest `limit + 1` rows past the
 * cursor; the merge keeps the newest `limit` overall, so any row that belongs
 * on the page is present (a row in the top `limit` overall is in the top
 * `limit` of its source), and anything left over proves an older page exists.
 */
export async function composeChatFeed(
  store: ChatStore,
  agentId: string,
  opts: ComposeChatFeedOptions = {}
): Promise<ChatFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const { db } = store;
  const [
    chat,
    status,
    agentMessages,
    media,
    reviews,
    turns,
    pins,
    unreadCount,
  ] = await Promise.all([
    listChatEntries(db, agentId, cursor, limit + 1),
    listStatusEntries(db, agentId, cursor, limit + 1),
    listAgentMessageEntries(db, agentId, cursor, limit + 1),
    listMediaEntries(db, agentId, cursor, limit + 1),
    listReviewEntries(db, agentId, cursor, limit + 1),
    listTurnEntries(db, agentId, cursor, limit + 1),
    listPinEntries(db, agentId, cursor, limit + 1),
    store.countUnread(agentId),
  ]);

  const merged: Keyed<ChatFeedEntry>[] = [
    ...chat,
    ...status,
    ...agentMessages,
    ...media,
    ...reviews,
    ...turns,
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
