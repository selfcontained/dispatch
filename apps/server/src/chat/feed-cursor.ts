import type { ChatFeedEntry } from "@dispatch/shared";

import { isChatMessageId } from "./store.js";

export const CHAT_FEED_DEFAULT_LIMIT = 200;
export const CHAT_FEED_MAX_LIMIT = 500;

/**
 * Feed ordering is (created_at desc, source rank desc, id desc): a total
 * order across the sources, so a page boundary that falls on rows with
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

export const SOURCE_RANK: Record<ChatFeedEntry["type"], number> = {
  // assistant and activity share one source (agent_stream_events), so they
  // share one rank: the cursor tie-break on id is valid across both.
  assistant: 6,
  activity: 6,
  review: 5,
  chat: 4,
  status: 3,
  pin: 2,
  agent_message: 1,
  media: 0,
};

const AT_KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
export const AT_KEY_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

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
    case "assistant":
    case "activity":
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

export type Keyed<E extends ChatFeedEntry> = {
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
export function cursorClause(
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

export const intKey = (id: number) => String(id).padStart(20, "0");

/** Newest first: (atKey, source rank, id) descending. */
export function compareNewestFirst(
  a: Keyed<ChatFeedEntry>,
  b: Keyed<ChatFeedEntry>
): number {
  if (a.atKey !== b.atKey) return a.atKey < b.atKey ? 1 : -1;
  const rank = SOURCE_RANK[b.entry.type] - SOURCE_RANK[a.entry.type];
  if (rank !== 0) return rank;
  if (a.idKey === b.idKey) return 0;
  return a.idKey < b.idKey ? 1 : -1;
}
