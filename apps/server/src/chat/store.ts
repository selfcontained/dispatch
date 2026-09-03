import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ChatAnswer,
  ChatAttachment,
  ChatAuthorKind,
  ChatMessage,
  ChatMessageKind,
  ChatQuestion,
} from "@dispatch/shared";

export type InsertChatMessageInput = {
  agentId: string;
  authorKind: ChatAuthorKind;
  kind?: ChatMessageKind;
  text: string;
  replyTo?: string | null;
  question?: ChatQuestion | null;
  attachments?: ChatAttachment[];
  /** User messages only. */
  delivered?: boolean | null;
};

export type UpdateChatMessageInput = {
  text?: string;
  kind?: ChatMessageKind;
  question?: ChatQuestion | null;
  attachments?: ChatAttachment[];
};

export type ListChatMessagesOptions = {
  /** ISO timestamp or Date; only rows strictly older are returned. */
  before?: string | Date | null;
  limit: number;
};

type Row = {
  id: string;
  agent_id: string;
  author_kind: ChatAuthorKind;
  kind: ChatMessageKind;
  text: string;
  reply_to: string | null;
  question: ChatQuestion | null;
  answer: ChatAnswer | null;
  attachments: ChatAttachment[] | null;
  delivered: boolean | null;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function toChatMessage(row: Row): ChatMessage {
  return {
    id: row.id,
    agentId: row.agent_id,
    authorKind: row.author_kind,
    kind: row.kind,
    text: row.text,
    replyTo: row.reply_to,
    question: row.question ?? null,
    answer: row.answer ?? null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    delivered: row.delivered,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toCursor(before: string | Date | null | undefined): Date | null {
  if (!before) return null;
  const date = before instanceof Date ? before : new Date(before);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ChatStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: InsertChatMessageInput): Promise<ChatMessage> {
    const result = await this.pool.query<Row>(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, reply_to, question,
          attachments, delivered)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING *`,
      [
        randomUUID(),
        input.agentId,
        input.authorKind,
        input.kind ?? "reply",
        input.text,
        input.replyTo ?? null,
        input.question ? JSON.stringify(input.question) : null,
        JSON.stringify(input.attachments ?? []),
        input.delivered ?? null,
      ]
    );
    return toChatMessage(result.rows[0]);
  }

  /**
   * Apply a partial update. Only the supplied keys change; `question: null`
   * clears the question. Returns null when no row matches.
   */
  async update(
    id: string,
    patch: UpdateChatMessageInput
  ): Promise<ChatMessage | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.text !== undefined) push("text", patch.text);
    if (patch.kind !== undefined) push("kind", patch.kind);
    if (patch.question !== undefined) {
      values.push(patch.question ? JSON.stringify(patch.question) : null);
      sets.push(`question = $${values.length}::jsonb`);
    }
    if (patch.attachments !== undefined) {
      values.push(JSON.stringify(patch.attachments));
      sets.push(`attachments = $${values.length}::jsonb`);
    }
    if (sets.length === 0) return this.getById(id);
    values.push(id);
    const result = await this.pool.query<Row>(
      `UPDATE agent_chat_messages
          SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }

  /** User messages only: record whether pane injection succeeded. */
  async setDelivered(id: string, delivered: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE agent_chat_messages SET delivered = $2 WHERE id = $1`,
      [id, delivered]
    );
  }

  async getById(id: string): Promise<ChatMessage | null> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM agent_chat_messages WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }

  /**
   * Newest `limit` messages older than `before`, returned oldest first.
   * `hasMore` says whether older rows exist beyond the page.
   */
  async list(
    agentId: string,
    opts: ListChatMessagesOptions
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const result = await this.pool.query<Row>(
      `SELECT * FROM agent_chat_messages
        WHERE agent_id = $1
          AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [agentId, toCursor(opts.before), limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const page = result.rows.slice(0, limit).reverse();
    return { messages: page.map(toChatMessage), hasMore };
  }

  /**
   * Mark unread agent messages as read. With `upTo`, only messages created
   * at or before that message (an unknown id marks nothing). Returns the
   * number of rows updated.
   */
  async markRead(agentId: string, upTo?: string | null): Promise<number> {
    const result = upTo
      ? await this.pool.query(
          `UPDATE agent_chat_messages AS m SET read_at = now()
            FROM agent_chat_messages AS bound
           WHERE bound.id = $2 AND bound.agent_id = $1
             AND m.agent_id = $1 AND m.author_kind = 'agent'
             AND m.read_at IS NULL
             AND m.created_at <= bound.created_at`,
          [agentId, upTo]
        )
      : await this.pool.query(
          `UPDATE agent_chat_messages SET read_at = now()
            WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL`,
          [agentId]
        );
    return result.rowCount ?? 0;
  }

  async countUnread(agentId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_chat_messages
        WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL`,
      [agentId]
    );
    return Number(result.rows[0].count);
  }

  /**
   * Set the answer on an unanswered question. Returns null when the message
   * is missing, not a question, or already answered — callers map that to
   * 404/409 as they see fit after a fresh `getById`.
   */
  async recordAnswer(
    questionId: string,
    answer: ChatAnswer
  ): Promise<ChatMessage | null> {
    const result = await this.pool.query<Row>(
      `UPDATE agent_chat_messages
          SET answer = $2::jsonb, updated_at = now()
        WHERE id = $1 AND kind = 'question' AND answer IS NULL
        RETURNING *`,
      [questionId, JSON.stringify(answer)]
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }
}
