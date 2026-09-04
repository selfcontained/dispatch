import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type {
  ChatAnswer,
  ChatAttachment,
  ChatAuthorKind,
  ChatMessage,
  ChatMessageKind,
  ChatMessageOrigin,
  ChatQuestion,
  ChatUnreadSummary,
} from "@dispatch/shared";

/** A pool or a checked-out client — lets one store run inside a transaction. */
export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
};

export type InsertChatMessageInput = {
  /**
   * Explicit row id. Launch posts fix it before the write so the pane
   * envelope built alongside can carry it; everything else lets the store
   * mint one.
   */
  id?: string;
  agentId: string;
  authorKind: ChatAuthorKind;
  kind?: ChatMessageKind;
  text: string;
  replyTo?: string | null;
  question?: ChatQuestion | null;
  attachments?: ChatAttachment[];
  /** User messages only; `null` = delivery pending. */
  delivered?: boolean | null;
  /** Launch-context posts only; see `ChatMessage.origin`. */
  origin?: ChatMessageOrigin | null;
  /** Launch-context posts only: the agent that created this one. */
  launchedByAgentId?: string | null;
};

export type UpdateChatMessageInput = {
  text?: string;
  kind?: ChatMessageKind;
  question?: ChatQuestion | null;
  attachments?: ChatAttachment[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Message ids are uuid columns: an ill-formed id is "not found", never a 500. */
export function isChatMessageId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

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
  origin: ChatMessageOrigin | null;
  launched_by_agent_id: string | null;
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
    // Absent, not null, on the wire: ordinary posts carry neither key.
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.launched_by_agent_id
      ? { launchedByAgentId: row.launched_by_agent_id }
      : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ChatStore {
  constructor(readonly db: Queryable) {}

  /** The same store bound to a transaction client. */
  withClient(client: PoolClient): ChatStore {
    return new ChatStore(client);
  }

  async insert(input: InsertChatMessageInput): Promise<ChatMessage> {
    const result = await this.db.query<Row>(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, reply_to, question,
          attachments, delivered, origin, launched_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.agentId,
        input.authorKind,
        input.kind ?? "reply",
        input.text,
        input.replyTo ?? null,
        input.question ? JSON.stringify(input.question) : null,
        JSON.stringify(input.attachments ?? []),
        input.delivered ?? null,
        input.origin ?? null,
        input.launchedByAgentId ?? null,
      ]
    );
    return toChatMessage(result.rows[0]);
  }

  /**
   * Insert a row whose id the caller fixed in advance, tolerating a
   * collision. Returns null when a row with that id already exists — the
   * launch path needs to know that its post was *not* written by this call,
   * because an envelope naming a row someone else owns is exactly the
   * confusion the id was meant to prevent.
   */
  async insertIfAbsent(
    input: InsertChatMessageInput & { id: string }
  ): Promise<ChatMessage | null> {
    const result = await this.db.query<Row>(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, reply_to, question,
          attachments, delivered, origin, launched_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        input.id,
        input.agentId,
        input.authorKind,
        input.kind ?? "reply",
        input.text,
        input.replyTo ?? null,
        input.question ? JSON.stringify(input.question) : null,
        JSON.stringify(input.attachments ?? []),
        input.delivered ?? null,
        input.origin ?? null,
        input.launchedByAgentId ?? null,
      ]
    );
    const row = result.rows[0];
    return row ? toChatMessage(row) : null;
  }

  /**
   * Apply a partial update. Only the supplied keys change; `question: null`
   * clears the question. Returns null when no row matches.
   */
  async update(
    id: string,
    patch: UpdateChatMessageInput
  ): Promise<ChatMessage | null> {
    if (!isChatMessageId(id)) return null;
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
    const result = await this.db.query<Row>(
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
    if (!isChatMessageId(id)) return;
    await this.db.query(
      `UPDATE agent_chat_messages SET delivered = $2 WHERE id = $1`,
      [id, delivered]
    );
  }

  /**
   * Startup recovery: a user row still `delivered IS NULL` belongs to a
   * delivery that was waiting in a previous process's in-memory queue and
   * died with it. Mark them all not-delivered so the UI offers a resend
   * instead of showing "pending" forever. Returns the distinct agent ids
   * touched, so the caller can publish one `chat.changed` per feed.
   */
  async sweepPendingDeliveries(): Promise<string[]> {
    const result = await this.db.query<{ agent_id: string }>(
      `UPDATE agent_chat_messages SET delivered = false
        WHERE author_kind = 'user' AND delivered IS NULL
        RETURNING agent_id`
    );
    return [...new Set(result.rows.map((row) => row.agent_id))];
  }

  /** The launch-context post recorded when the agent was created, if any. */
  async getLaunchPost(agentId: string): Promise<ChatMessage | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_chat_messages
        WHERE agent_id = $1 AND origin = 'launch'
        ORDER BY created_at ASC
        LIMIT 1`,
      [agentId]
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }

  async getById(id: string): Promise<ChatMessage | null> {
    if (!isChatMessageId(id)) return null;
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_chat_messages WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }

  /**
   * Mark unread agent messages as read. With `upTo`, only messages created
   * at or before that message (an unknown id marks nothing). Returns the
   * number of rows updated.
   */
  async markRead(agentId: string, upTo?: string | null): Promise<number> {
    if (upTo != null && !isChatMessageId(upTo)) return 0;
    const result = upTo
      ? await this.db.query(
          `UPDATE agent_chat_messages AS m SET read_at = now()
            FROM agent_chat_messages AS bound
           WHERE bound.id = $2 AND bound.agent_id = $1
             AND m.agent_id = $1 AND m.author_kind = 'agent'
             AND m.read_at IS NULL
             AND m.created_at <= bound.created_at`,
          [agentId, upTo]
        )
      : await this.db.query(
          `UPDATE agent_chat_messages SET read_at = now()
            WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL`,
          [agentId]
        );
    return result.rowCount ?? 0;
  }

  async countUnread(agentId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_chat_messages
        WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL`,
      [agentId]
    );
    return Number(result.rows[0].count);
  }

  /**
   * Unread and unanswered-question counts for every non-deleted agent that
   * has a non-zero value — one grouped query, for the sidebar badges.
   */
  async unreadSummary(): Promise<ChatUnreadSummary> {
    const result = await this.db.query<{
      agent_id: string;
      unread: string;
      pending: string;
    }>(
      `SELECT m.agent_id,
              COUNT(*) FILTER (WHERE m.read_at IS NULL)::text AS unread,
              COUNT(*) FILTER (WHERE m.kind = 'question' AND m.answer IS NULL)::text AS pending
         FROM agent_chat_messages m
         JOIN agents a ON a.id = m.agent_id AND a.deleted_at IS NULL
        WHERE m.author_kind = 'agent'
          AND (m.read_at IS NULL OR (m.kind = 'question' AND m.answer IS NULL))
        GROUP BY m.agent_id`
    );
    const agents: ChatUnreadSummary["agents"] = {};
    for (const row of result.rows) {
      agents[row.agent_id] = {
        unread: Number(row.unread),
        pendingQuestions: Number(row.pending),
      };
    }
    return { agents };
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
    if (!isChatMessageId(questionId)) return null;
    const result = await this.db.query<Row>(
      `UPDATE agent_chat_messages
          SET answer = $2::jsonb, updated_at = now()
        WHERE id = $1 AND kind = 'question' AND answer IS NULL
        RETURNING *`,
      [questionId, JSON.stringify(answer)]
    );
    return result.rows[0] ? toChatMessage(result.rows[0]) : null;
  }
}
