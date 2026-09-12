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
  ChatReaction,
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
  /** Launch posts: text delivered to a harness when it differs from the post. */
  deliveryText?: string | null;
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

/**
 * A reaction as the feed query aggregates it into JSON: `createdAt` is the
 * timestamptz's JSON text, normalized to ISO on the way out.
 */
type ReactionJson = {
  id: string;
  authorKind: ChatAuthorKind;
  emoji: string;
  delivered: boolean | null;
  createdAt: string;
};

type ReactionRow = {
  id: string;
  message_id: string;
  agent_id: string;
  author_kind: ChatAuthorKind;
  emoji: string;
  delivered: boolean | null;
  created_at: Date;
};

function toChatReaction(row: ReactionRow): ChatReaction {
  return {
    id: row.id,
    authorKind: row.author_kind,
    emoji: row.emoji,
    delivered: row.delivered,
    createdAt: row.created_at.toISOString(),
  };
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
  delivery_text?: string | null;
  /** Only on rows read through the feed query; see `listChatEntries`. */
  reactions?: ReactionJson[] | null;
  created_at: Date;
  updated_at: Date;
};

/** A launch post plus the text its first turn delivers (harness agents). */
export type LaunchPost = ChatMessage & { deliveryText: string | null };

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
    ...(Array.isArray(row.reactions) && row.reactions.length > 0
      ? {
          reactions: row.reactions.map((reaction) => ({
            id: reaction.id,
            authorKind: reaction.authorKind,
            emoji: reaction.emoji,
            delivered: reaction.delivered,
            createdAt: new Date(reaction.createdAt).toISOString(),
          })),
        }
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
          attachments, delivered, origin, launched_by_agent_id, delivery_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
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
        input.deliveryText ?? null,
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
          attachments, delivered, origin, launched_by_agent_id, delivery_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
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
        input.deliveryText ?? null,
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
          AND agent_id NOT IN (
            SELECT id FROM agents
             WHERE type = 'dispatch' AND status = 'running' AND deleted_at IS NULL
          )
        RETURNING agent_id`
    );
    return [...new Set(result.rows.map((row) => row.agent_id))];
  }

  /** The same sweep for named agents only (a harness that did not come back). */
  async sweepPendingDeliveriesFor(agentIds: string[]): Promise<string[]> {
    if (agentIds.length === 0) return [];
    const result = await this.db.query<{ agent_id: string }>(
      `UPDATE agent_chat_messages SET delivered = false
        WHERE author_kind = 'user' AND delivered IS NULL
          AND agent_id = ANY($1::text[])
        RETURNING agent_id`,
      [agentIds]
    );
    return [...new Set(result.rows.map((row) => row.agent_id))];
  }

  /**
   * User reactions still pending from a previous process, marked
   * not-delivered for the same reason as `sweepPendingDeliveries`. Returns
   * the distinct agent ids touched.
   */
  async sweepPendingReactions(): Promise<string[]> {
    const result = await this.db.query<{ agent_id: string }>(
      `UPDATE agent_chat_reactions SET delivered = false
        WHERE author_kind = 'user' AND delivered IS NULL
        RETURNING agent_id`
    );
    return [...new Set(result.rows.map((row) => row.agent_id))];
  }

  /** User messages still waiting to be delivered, oldest first. */
  async listPendingDeliveries(agentId: string): Promise<ChatMessage[]> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_chat_messages
        WHERE agent_id = $1 AND author_kind = 'user' AND delivered IS NULL
        ORDER BY created_at ASC`,
      [agentId]
    );
    return result.rows.map(toChatMessage);
  }

  /** The launch-context post recorded when the agent was created, if any. */
  async getLaunchPost(agentId: string): Promise<LaunchPost | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_chat_messages
        WHERE agent_id = $1 AND origin = 'launch'
        ORDER BY created_at ASC
        LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    return row
      ? { ...toChatMessage(row), deliveryText: row.delivery_text ?? null }
      : null;
  }

  /** A message's reactions, oldest first — the order the feed lists them in. */
  async listReactions(messageId: string): Promise<ChatReaction[]> {
    if (!isChatMessageId(messageId)) return [];
    const result = await this.db.query<ReactionRow>(
      `SELECT * FROM agent_chat_reactions
        WHERE message_id = $1
        ORDER BY created_at, id`,
      [messageId]
    );
    return result.rows.map(toChatReaction);
  }

  /**
   * Add one reaction. Returns null when this author already put that emoji
   * on the message — a double click or a second tab raced this one, and the
   * reaction that won is the one that gets delivered.
   */
  async insertReaction(input: {
    agentId: string;
    messageId: string;
    authorKind: ChatAuthorKind;
    emoji: string;
    delivered: boolean | null;
  }): Promise<ChatReaction | null> {
    const result = await this.db.query<ReactionRow>(
      `INSERT INTO agent_chat_reactions
         (id, message_id, agent_id, author_kind, emoji, delivered)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id, author_kind, emoji) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.messageId,
        input.agentId,
        input.authorKind,
        input.emoji,
        input.delivered,
      ]
    );
    return result.rows[0] ? toChatReaction(result.rows[0]) : null;
  }

  /** Remove one author's reaction; false when it was not there. */
  async deleteReaction(
    messageId: string,
    authorKind: ChatAuthorKind,
    emoji: string
  ): Promise<boolean> {
    if (!isChatMessageId(messageId)) return false;
    const result = await this.db.query(
      `DELETE FROM agent_chat_reactions
        WHERE message_id = $1 AND author_kind = $2 AND emoji = $3`,
      [messageId, authorKind, emoji]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * How many posts the message's author has made on this feed since it — so
   * a reaction envelope can say "your latest message" or "3 posts ago".
   * Compared against the stored timestamp, not the millisecond ISO on the
   * wire, which would put a row after itself.
   */
  async countLaterPostsBySameAuthor(messageId: string): Promise<number> {
    if (!isChatMessageId(messageId)) return 0;
    const result = await this.db.query<{ later: number }>(
      `SELECT COUNT(later.id)::int AS later
         FROM agent_chat_messages m
         JOIN agent_chat_messages later
           ON later.agent_id = m.agent_id
          AND later.author_kind = m.author_kind
          AND (later.created_at, later.id) > (m.created_at, m.id)
        WHERE m.id = $1`,
      [messageId]
    );
    return result.rows[0]?.later ?? 0;
  }

  /** Record whether a reaction's pane injection succeeded. */
  async setReactionDelivered(id: string, delivered: boolean): Promise<void> {
    if (!isChatMessageId(id)) return;
    await this.db.query(
      `UPDATE agent_chat_reactions SET delivered = $2 WHERE id = $1`,
      [id, delivered]
    );
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
   * Mark unread agent messages read — up to and including `upTo`, or all of
   * them. Reports what was marked so a client can mirror it on the rows it
   * holds: `readAt` is the stamp written, `upToAt` the bound's created time
   * (null when everything was marked). Both null when nothing changed.
   */
  async markRead(
    agentId: string,
    upTo?: string | null
  ): Promise<{
    updated: number;
    readAt: string | null;
    upToAt: string | null;
  }> {
    const none = { updated: 0, readAt: null, upToAt: null };
    if (upTo != null && !isChatMessageId(upTo)) return none;
    const result = upTo
      ? await this.db.query<{ read_at: Date; up_to_at: Date }>(
          `UPDATE agent_chat_messages AS m SET read_at = now()
            FROM agent_chat_messages AS bound
           WHERE bound.id = $2 AND bound.agent_id = $1
             AND m.agent_id = $1 AND m.author_kind = 'agent'
             AND m.read_at IS NULL
             AND m.created_at <= bound.created_at
           RETURNING m.read_at, bound.created_at AS up_to_at`,
          [agentId, upTo]
        )
      : await this.db.query<{ read_at: Date; up_to_at: null }>(
          `UPDATE agent_chat_messages SET read_at = now()
            WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL
           RETURNING read_at, NULL AS up_to_at`,
          [agentId]
        );
    const first = result.rows[0];
    if (!first) return none;
    return {
      updated: result.rowCount ?? result.rows.length,
      readAt: first.read_at.toISOString(),
      upToAt: first.up_to_at ? first.up_to_at.toISOString() : null,
    };
  }

  /**
   * Move the agent's turn watermark to now. Deliberately not bounded by the
   * read's `upTo`: the pane sends the newest agent chat message it holds,
   * which on a harness agent is older than the turns on screen, and a
   * watermark held at that message would never clear them.
   */
  async markFeedRead(agentId: string): Promise<void> {
    await this.db.query(
      `UPDATE agents SET chat_read_at = NOW() WHERE id = $1`,
      [agentId]
    );
  }

  async countUnread(agentId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM agent_chat_messages
           WHERE agent_id = $1 AND author_kind = 'agent' AND read_at IS NULL)
         + (SELECT COUNT(*) FROM agent_stream_events s
             JOIN agents a ON a.id = s.agent_id
            WHERE s.agent_id = $1 AND s.kind = 'turn'
              AND s.payload->>'state' = 'settled'
              AND s.updated_at > COALESCE(a.chat_read_at, '-infinity'))
       )::text AS count`,
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
      `SELECT agent_id,
              SUM(unread)::text AS unread,
              SUM(pending)::text AS pending
         FROM (
           SELECT m.agent_id,
                  COUNT(*) FILTER (WHERE m.read_at IS NULL) AS unread,
                  COUNT(*) FILTER (WHERE m.kind = 'question' AND m.answer IS NULL) AS pending
             FROM agent_chat_messages m
             JOIN agents a ON a.id = m.agent_id AND a.deleted_at IS NULL
            WHERE m.author_kind = 'agent'
              AND (m.read_at IS NULL OR (m.kind = 'question' AND m.answer IS NULL))
            GROUP BY m.agent_id
           UNION ALL
           SELECT s.agent_id, COUNT(*) AS unread, 0 AS pending
             FROM agent_stream_events s
             JOIN agents a ON a.id = s.agent_id AND a.deleted_at IS NULL
            WHERE s.kind = 'turn'
              AND s.payload->>'state' = 'settled'
              AND s.updated_at > COALESCE(a.chat_read_at, '-infinity')
            GROUP BY s.agent_id
         ) counts
        GROUP BY agent_id`
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
