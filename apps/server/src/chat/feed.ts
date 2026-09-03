import type { Pool } from "pg";
import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import { ChatStore } from "./store.js";

export const CHAT_FEED_DEFAULT_LIMIT = 200;
export const CHAT_FEED_MAX_LIMIT = 500;

export type ComposeChatFeedOptions = {
  before?: string | Date | null;
  limit?: number;
};

function toCursor(before: string | Date | null | undefined): Date | null {
  if (!before) return null;
  const date = before instanceof Date ? before : new Date(before);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clampFeedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return CHAT_FEED_DEFAULT_LIMIT;
  }
  return Math.min(CHAT_FEED_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

async function listStatusEntries(
  pool: Pool,
  agentId: string,
  before: Date | null,
  limit: number
): Promise<ChatStatusEntry[]> {
  const result = await pool.query<{
    id: number;
    event_type: string;
    message: string;
    created_at: Date;
  }>(
    `SELECT id, event_type, message, created_at FROM agent_events
      WHERE agent_id = $1
        AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [agentId, before, limit]
  );
  return result.rows.map((row) => ({
    type: "status",
    id: `event:${row.id}`,
    eventType: row.event_type,
    message: row.message,
    at: row.created_at.toISOString(),
  }));
}

async function listAgentMessageEntries(
  pool: Pool,
  agentId: string,
  before: Date | null,
  limit: number
): Promise<ChatAgentMessageEntry[]> {
  const result = await pool.query<{
    id: string;
    sender_agent_id: string;
    recipient_agent_id: string;
    sender_name: string;
    recipient_name: string;
    content: string;
    delivered: boolean;
    created_at: Date;
  }>(
    `SELECT id, sender_agent_id, recipient_agent_id, sender_name,
            recipient_name, content, delivered, created_at
       FROM agent_messages
      WHERE (sender_agent_id = $1 OR recipient_agent_id = $1)
        AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [agentId, before, limit]
  );
  return result.rows.map((row) => ({
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
  }));
}

async function listMediaEntries(
  pool: Pool,
  agentId: string,
  before: Date | null,
  limit: number
): Promise<ChatMediaEntry[]> {
  const result = await pool.query<{
    id: number;
    file_name: string;
    size_bytes: number;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT id, file_name, size_bytes, description, created_at FROM media
      WHERE agent_id = $1
        AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [agentId, before, limit]
  );
  return result.rows.map((row) => ({
    type: "media",
    id: `media:${row.id}`,
    mediaId: row.id,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    description: row.description ?? null,
    at: row.created_at.toISOString(),
  }));
}

/**
 * Compose one agent's Chat feed at read time from chat messages, status
 * events, cross-agent messages, and shared media. Each source contributes
 * its newest `limit + 1` rows older than `before`; the merge keeps the
 * newest `limit` overall, so any row that belongs on the page is present
 * (a row in the top `limit` overall is in the top `limit` of its source),
 * and anything left over proves an older page exists.
 */
export async function composeChatFeed(
  pool: Pool,
  agentId: string,
  opts: ComposeChatFeedOptions = {}
): Promise<ChatFeedResponse> {
  const limit = clampFeedLimit(opts.limit);
  const before = toCursor(opts.before);
  const store = new ChatStore(pool);
  const [chat, status, agentMessages, media, unreadCount] = await Promise.all([
    store.list(agentId, { before, limit }),
    listStatusEntries(pool, agentId, before, limit + 1),
    listAgentMessageEntries(pool, agentId, before, limit + 1),
    listMediaEntries(pool, agentId, before, limit + 1),
    store.countUnread(agentId),
  ]);

  const merged: ChatFeedEntry[] = [
    ...chat.messages.map(
      (message): ChatFeedEntry => ({
        type: "chat",
        id: message.id,
        at: message.createdAt,
        message,
      })
    ),
    ...status,
    ...agentMessages,
    ...media,
  ];
  merged.sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  });
  const overflow = merged.length > limit || chat.hasMore;
  const page = merged.slice(0, limit).reverse();
  return { entries: page, hasMore: overflow, unreadCount };
}
