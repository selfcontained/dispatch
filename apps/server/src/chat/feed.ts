import type { Pool } from "pg";
import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import { ChatStore, toChatMessage } from "./store.js";

export const CHAT_FEED_DEFAULT_LIMIT = 200;
export const CHAT_FEED_MAX_LIMIT = 500;

export type ComposeChatFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
};

/**
 * Feed ordering is (created_at desc, source rank desc, id desc) — a total
 * order across the four tables, so a page boundary that falls on rows with
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
  chat: 3,
  status: 2,
  agent_message: 1,
  media: 0,
};

const AT_KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const AT_KEY_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Serial ids: digits only, and small enough for a Postgres int4 cast. */
const SERIAL_ID_RE = /^\d{1,10}$/;

function isValidCursorId(type: ChatFeedEntry["type"], id: string): boolean {
  switch (type) {
    case "chat":
    case "agent_message":
      return UUID_RE.test(id);
    case "status":
    case "media":
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
 * source breaks the tie on id.
 */
function cursorClause(
  type: ChatFeedEntry["type"],
  idCast: "int" | "uuid",
  cursor: FeedCursor | null,
  params: unknown[]
): string {
  if (!cursor) return "";
  params.push(cursor.at);
  const ts = `($${params.length}::timestamp AT TIME ZONE 'UTC')`;
  const rank = SOURCE_RANK[type];
  const cursorRank = SOURCE_RANK[cursor.type];
  if (rank > cursorRank) return `AND created_at < ${ts}`;
  if (rank < cursorRank) return `AND created_at <= ${ts}`;
  params.push(idCast === "int" ? Number(cursor.id) : cursor.id);
  return `AND (created_at < ${ts} OR (created_at = ${ts} AND id < $${params.length}::${idCast}))`;
}

const intKey = (id: number) => String(id).padStart(20, "0");

async function listChatEntries(
  pool: Pool,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatFeedEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("chat", "uuid", cursor, params);
  params.push(limit);
  const result = await pool.query<
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
  pool: Pool,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatStatusEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("status", "int", cursor, params);
  params.push(limit);
  const result = await pool.query<{
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
  pool: Pool,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatAgentMessageEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("agent_message", "uuid", cursor, params);
  params.push(limit);
  const result = await pool.query<{
    id: string;
    sender_agent_id: string;
    recipient_agent_id: string;
    sender_name: string;
    recipient_name: string;
    content: string;
    delivered: boolean;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, sender_agent_id, recipient_agent_id, sender_name,
            recipient_name, content, delivered, created_at,
            ${AT_KEY_SQL} AS at_key
       FROM agent_messages
      WHERE (sender_agent_id = $1 OR recipient_agent_id = $1) ${clause}
      ORDER BY created_at DESC, id DESC
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
  pool: Pool,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatMediaEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("media", "int", cursor, params);
  params.push(limit);
  const result = await pool.query<{
    id: number;
    file_name: string;
    size_bytes: number;
    description: string | null;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, file_name, size_bytes, description, created_at,
            ${AT_KEY_SQL} AS at_key
       FROM media
      WHERE agent_id = $1 ${clause}
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
 * Compose one agent's Chat feed at read time from chat messages, status
 * events, cross-agent messages, and shared media. Each source contributes
 * its newest `limit + 1` rows past the cursor; the merge keeps the newest
 * `limit` overall, so any row that belongs on the page is present (a row in
 * the top `limit` overall is in the top `limit` of its source), and anything
 * left over proves an older page exists.
 */
export async function composeChatFeed(
  pool: Pool,
  agentId: string,
  opts: ComposeChatFeedOptions = {}
): Promise<ChatFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const cursor = opts.cursor ?? null;
  const store = new ChatStore(pool);
  const [chat, status, agentMessages, media, unreadCount] = await Promise.all([
    listChatEntries(pool, agentId, cursor, limit + 1),
    listStatusEntries(pool, agentId, cursor, limit + 1),
    listAgentMessageEntries(pool, agentId, cursor, limit + 1),
    listMediaEntries(pool, agentId, cursor, limit + 1),
    store.countUnread(agentId),
  ]);

  const merged: Keyed<ChatFeedEntry>[] = [
    ...chat,
    ...status,
    ...agentMessages,
    ...media,
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
