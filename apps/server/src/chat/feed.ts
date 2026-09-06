import type {
  ChatAgentMessageEntry,
  ChatAttachment,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatPinEntry,
  ChatReviewEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import { dimensionFields, parseMediaMetadata } from "../media/metadata.js";

import {
  type ChatStore,
  isChatMessageId,
  type Queryable,
  toChatMessage,
} from "./store.js";

export const CHAT_FEED_DEFAULT_LIMIT = 200;
export const CHAT_FEED_MAX_LIMIT = 500;

export type ComposeChatFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
};

/**
 * Feed ordering is (created_at desc, source rank desc, id desc) — a total
 * order across the six tables, so a page boundary that falls on rows with
 * identical timestamps never drops or repeats a row. The cursor names the
 * last entry of the previous page in that order. `at` is Postgres microsecond
 * text (`to_char(..., 'YYYY-MM-DD HH24:MI:SS.US')`), not the millisecond ISO
 * `at` the entries expose, so equality comparisons are exact.
 */
export type FeedCursor = {
  at: string;
  type: ChatFeedEntry["type"];
  id: string;
};

const SOURCE_RANK: Record<ChatFeedEntry["type"], number> = {
  review: 5,
  chat: 4,
  status: 3,
  pin: 2,
  agent_message: 1,
  media: 0,
};

const AT_KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const AT_KEY_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Serial ids: digits only, and small enough for a Postgres int4 cast. */
const SERIAL_ID_RE = /^\d{1,10}$/;

function isValidCursorId(type: ChatFeedEntry["type"], id: string): boolean {
  switch (type) {
    case "chat":
    case "agent_message":
      return isChatMessageId(id);
    case "status":
    case "media":
    case "review":
    case "pin":
      return SERIAL_ID_RE.test(id) && Number(id) <= 2_147_483_647;
  }
}

/**
 * Shape-valid text like `2026-02-30 25:61:00.000000` would still reach the
 * timestamp cast and fail there; round-trip through Date so only real
 * instants pass (JS normalises impossible dates, so the re-rendered ISO
 * string must match).
 */
function isRealTimestamp(at: string): boolean {
  // JS accepts year 0000; Postgres does not (there is no year zero).
  if (at.startsWith("0000-")) return false;
  const iso = `${at.slice(0, 10)}T${at.slice(11, 23)}Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
}

/**
 * Returns null for anything that is not a cursor this server produced —
 * every field is checked against what its source column can hold, so a
 * rejected cursor is a 400 at the route and never a failed cast in SQL.
 */
export function decodeFeedCursor(raw: string): FeedCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { at, type, id } = parsed as Record<string, unknown>;
  if (typeof at !== "string" || !AT_KEY_RE.test(at) || !isRealTimestamp(at)) {
    return null;
  }
  if (typeof type !== "string" || !(type in SOURCE_RANK)) return null;
  const sourceType = type as ChatFeedEntry["type"];
  if (typeof id !== "string" || !isValidCursorId(sourceType, id)) return null;
  return { at, type: sourceType, id };
}

export function clampFeedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return CHAT_FEED_DEFAULT_LIMIT;
  }
  return Math.min(CHAT_FEED_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

type Keyed<E extends ChatFeedEntry> = {
  entry: E;
  atKey: string;
  /** Raw id for the cursor and the SQL tuple comparison. */
  rawId: string;
  /** Fixed-width form so JS ordering matches the column's ordering. */
  idKey: string;
};

/**
 * "Older than the cursor" for one source. `$1` is the agent id; the clause
 * appends its own parameters. Sources ranked below the cursor's include the
 * cursor timestamp itself; those above it exclude it; the cursor's own
 * source breaks the tie on id. `alias` qualifies the columns for a source
 * whose query joins other tables that have `id`/`created_at` of their own.
 */
function cursorClause(
  type: ChatFeedEntry["type"],
  idCast: "int" | "uuid",
  cursor: FeedCursor | null,
  params: unknown[],
  alias = ""
): string {
  if (!cursor) return "";
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  params.push(cursor.at);
  const ts = `($${params.length}::timestamp AT TIME ZONE 'UTC')`;
  const rank = SOURCE_RANK[type];
  const cursorRank = SOURCE_RANK[cursor.type];
  if (rank > cursorRank) return `AND ${col("created_at")} < ${ts}`;
  if (rank < cursorRank) return `AND ${col("created_at")} <= ${ts}`;
  params.push(idCast === "int" ? Number(cursor.id) : cursor.id);
  return `AND (${col("created_at")} < ${ts} OR (${col("created_at")} = ${ts} AND ${col("id")} < $${params.length}::${idCast}))`;
}

const intKey = (id: number) => String(id).padStart(20, "0");

async function listChatEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatFeedEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("chat", "uuid", cursor, params);
  params.push(limit);
  const result = await db.query<
    Parameters<typeof toChatMessage>[0] & { at_key: string }
  >(
    `SELECT *, ${AT_KEY_SQL} AS at_key FROM agent_chat_messages
      WHERE agent_id = $1 ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
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
    entry: {
      type: "status",
      id: `event:${row.id}`,
      eventType: row.event_type,
      message: row.message,
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
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

/** Newest first: (atKey, source rank, id) descending. */
function compareNewestFirst(a: Keyed<ChatFeedEntry>, b: Keyed<ChatFeedEntry>) {
  if (a.atKey !== b.atKey) return a.atKey < b.atKey ? 1 : -1;
  const rank = SOURCE_RANK[b.entry.type] - SOURCE_RANK[a.entry.type];
  if (rank !== 0) return rank;
  if (a.idKey === b.idKey) return 0;
  return a.idKey < b.idKey ? 1 : -1;
}

/**
 * Fill in the `width`/`height` of a page's file attachments from the media rows
 * they point at.
 *
 * @mutates the attachments inside `entries`, in place.
 *
 * The live row is the only thing that can be right here. An attachment is
 * frozen into the message row as JSONB when the message is written, but the URL
 * it renders is not frozen with it: `dispatch_share_file` replaces a file's
 * bytes in place and the historical post then serves the *new* ones. A shape
 * recorded at write time would describe bytes the post no longer has, which is
 * a wrong box rather than merely a plain one — so nothing is recorded at write
 * time and this is where the shape comes from.
 *
 * Purely additive. An attachment whose row is gone, or whose row has no
 * dimensions, is left without them and renders in the fixed-height fallback.
 */
async function applyLiveDimensions(
  db: Queryable,
  entries: Keyed<ChatFeedEntry>[]
): Promise<void> {
  type FileAttachment = Extract<ChatAttachment, { type: "file" }>;
  const pending = new Map<number, FileAttachment[]>();
  for (const item of entries) {
    if (item.entry.type !== "chat") continue;
    for (const attachment of item.entry.message.attachments) {
      if (attachment.type !== "file") continue;
      const targets = pending.get(attachment.mediaId);
      if (targets) targets.push(attachment);
      else pending.set(attachment.mediaId, [attachment]);
    }
  }
  if (pending.size === 0) return;

  const result = await db.query<{ id: number; metadata: unknown }>(
    `SELECT id, metadata FROM media WHERE id = ANY($1::int[])`,
    [[...pending.keys()]]
  );
  for (const row of result.rows) {
    const live = dimensionFields(parseMediaMetadata(row.metadata));
    for (const attachment of pending.get(row.id) ?? []) {
      Object.assign(attachment, live);
    }
  }
}

/**
 * Compose one agent's Chat feed at read time from chat messages, status
 * events, cross-agent messages, shared media, reviews, and pin activity.
 * Each source contributes its newest `limit + 1` rows past the cursor; the
 * merge keeps the newest `limit` overall, so any row that belongs on the page
 * is present (a row in the top `limit` overall is in the top `limit` of its
 * source), and anything left over proves an older page exists.
 */
export async function composeChatFeed(
  store: ChatStore,
  agentId: string,
  opts: ComposeChatFeedOptions = {}
): Promise<ChatFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const { db } = store;
  const [chat, status, agentMessages, media, reviews, pins, unreadCount] =
    await Promise.all([
      listChatEntries(db, agentId, cursor, limit + 1),
      listStatusEntries(db, agentId, cursor, limit + 1),
      listAgentMessageEntries(db, agentId, cursor, limit + 1),
      listMediaEntries(db, agentId, cursor, limit + 1),
      listReviewEntries(db, agentId, cursor, limit + 1),
      listPinEntries(db, agentId, cursor, limit + 1),
      store.countUnread(agentId),
    ]);

  const merged: Keyed<ChatFeedEntry>[] = [
    ...chat,
    ...status,
    ...agentMessages,
    ...media,
    ...reviews,
    ...pins,
  ].sort(compareNewestFirst);
  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  await applyLiveDimensions(db, page);
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
