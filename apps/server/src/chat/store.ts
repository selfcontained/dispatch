import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type {
  Block,
  BlockActor,
  BlockAuthor,
  BlockAuthorKind,
  BlockKind,
  BlockOrigin,
  BlockReaction,
  ChatAttachment,
  ChatUnreadSummary,
} from "@dispatch/shared";

/** A pool or a checked-out client — lets one store run inside a transaction. */
export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
};

export type InsertBlockInput = {
  /**
   * Explicit row id. Launch posts fix it before the write so the envelope
   * built alongside can carry it; a client mints one so its optimistic row
   * and the stored row are the same; everything else lets the store mint.
   */
  id?: string;
  streamId: string;
  author: BlockAuthor;
  toAgentId?: string | null;
  kind?: BlockKind;
  threadId?: string | null;
  replyTo?: string | null;
  text?: string;
  data?: unknown;
  state?: unknown;
  attachments?: ChatAttachment[];
  /** Blocks with `toAgentId`; `null` = delivery pending. */
  delivered?: boolean | null;
  origin?: BlockOrigin | null;
  launchedByAgentId?: string | null;
};

export type UpdateBlockInput = {
  text?: string;
  data?: unknown;
  /** Replaces the whole state; use `mergeState` for a partial change. */
  state?: unknown;
  attachments?: ChatAttachment[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Block ids are uuid columns: an ill-formed id is "not found", never a 500. */
export function isBlockId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function authorOf(
  kind: BlockAuthorKind,
  agentId: string | null
): BlockAuthor {
  return kind === "agent"
    ? { kind: "agent", agentId: agentId ?? "" }
    : { kind: "user" };
}

/** True when two authors are the same party. */
export function sameAuthor(a: BlockAuthor, b: BlockAuthor): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "user" || a.agentId === (b as { agentId: string }).agentId;
}

/**
 * A reaction as the feed query aggregates it into JSON: `createdAt` is the
 * timestamptz's JSON text, normalized to ISO on the way out.
 */
type ReactionJson = {
  id: string;
  authorKind: BlockAuthorKind;
  authorAgentId: string | null;
  emoji: string;
  delivered: boolean | null;
  createdAt: string;
};

type ReactionRow = {
  id: string;
  block_id: string;
  stream_id: string;
  author_kind: BlockAuthorKind;
  author_agent_id: string | null;
  emoji: string;
  delivered: boolean | null;
  created_at: Date;
};

function toReaction(row: ReactionRow): BlockReaction {
  return {
    id: row.id,
    author: authorOf(row.author_kind, row.author_agent_id),
    emoji: row.emoji,
    delivered: row.delivered,
    createdAt: row.created_at.toISOString(),
  };
}

export type BlockRow = {
  id: string;
  stream_id: string;
  author_kind: BlockAuthorKind;
  author_agent_id: string | null;
  to_agent_id: string | null;
  kind: BlockKind;
  thread_id: string | null;
  reply_to: string | null;
  text: string;
  data: unknown;
  state: unknown;
  attachments: ChatAttachment[] | null;
  origin: BlockOrigin | null;
  launched_by_agent_id: string | null;
  delivered: boolean | null;
  read_at: Date | null;
  /** Only on rows read through the feed query. */
  reactions?: ReactionJson[] | null;
  reply_count?: number | string | null;
  last_reply_at?: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function toBlock(row: BlockRow): Block {
  const base = {
    id: row.id,
    streamId: row.stream_id,
    author: authorOf(row.author_kind, row.author_agent_id),
    toAgentId: row.to_agent_id,
    threadId: row.thread_id,
    replyTo: row.reply_to,
    text: row.text,
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
            author: authorOf(reaction.authorKind, reaction.authorAgentId),
            emoji: reaction.emoji,
            delivered: reaction.delivered,
            createdAt: new Date(reaction.createdAt).toISOString(),
          })),
        }
      : {}),
    ...(row.reply_count !== undefined && row.reply_count !== null
      ? {
          replyCount: Number(row.reply_count),
          lastReplyAt: row.last_reply_at
            ? row.last_reply_at.toISOString()
            : null,
        }
      : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  // The kind decides the payload types; the store trusts what the service
  // validated on the way in.
  const body = {
    kind: row.kind,
    data: row.data ?? null,
    state: row.state ?? null,
  } as Block extends infer B
    ? B extends { kind: BlockKind }
      ? B
      : never
    : never;
  return { ...base, ...body } as Block;
}

const INSERT_COLUMNS = `(id, stream_id, author_kind, author_agent_id, to_agent_id, kind,
          thread_id, reply_to, text, data, state, attachments, delivered,
          origin, launched_by_agent_id)`;
const INSERT_VALUES = `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
          $12::jsonb, $13, $14, $15)`;

function insertParams(input: InsertBlockInput & { id: string }): unknown[] {
  return [
    input.id,
    input.streamId,
    input.author.kind,
    input.author.kind === "agent" ? input.author.agentId : null,
    input.toAgentId ?? null,
    input.kind ?? "text",
    input.threadId ?? null,
    input.replyTo ?? null,
    input.text ?? "",
    input.data === undefined || input.data === null
      ? null
      : JSON.stringify(input.data),
    input.state === undefined || input.state === null
      ? null
      : JSON.stringify(input.state),
    JSON.stringify(input.attachments ?? []),
    input.delivered ?? null,
    input.origin ?? null,
    input.launchedByAgentId ?? null,
  ];
}

export class BlockStore {
  constructor(readonly db: Queryable) {}

  /** The same store bound to a transaction client. */
  withClient(client: PoolClient): BlockStore {
    return new BlockStore(client);
  }

  async insert(input: InsertBlockInput): Promise<Block> {
    const result = await this.db.query<BlockRow>(
      `INSERT INTO blocks ${INSERT_COLUMNS} VALUES ${INSERT_VALUES} RETURNING *`,
      insertParams({ ...input, id: input.id ?? randomUUID() })
    );
    return toBlock(result.rows[0]);
  }

  /**
   * Insert a row whose id the caller fixed in advance, tolerating a
   * collision. Returns null when a row with that id already exists — the
   * launch path needs to know that its post was *not* written by this call,
   * because an envelope naming a row someone else owns is exactly the
   * confusion the id was meant to prevent.
   */
  async insertIfAbsent(
    input: InsertBlockInput & { id: string }
  ): Promise<Block | null> {
    const result = await this.db.query<BlockRow>(
      `INSERT INTO blocks ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      insertParams(input)
    );
    const row = result.rows[0];
    return row ? toBlock(row) : null;
  }

  /**
   * Apply a partial update. Only the supplied keys change. Returns null
   * when no row matches.
   */
  async update(id: string, patch: UpdateBlockInput): Promise<Block | null> {
    if (!isBlockId(id)) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${sql} = $${values.length}${cast}`);
    };
    if (patch.text !== undefined) push("text", patch.text);
    if (patch.data !== undefined) {
      push(
        "data",
        patch.data === null ? null : JSON.stringify(patch.data),
        "::jsonb"
      );
    }
    if (patch.state !== undefined) {
      push(
        "state",
        patch.state === null ? null : JSON.stringify(patch.state),
        "::jsonb"
      );
    }
    if (patch.attachments !== undefined) {
      push("attachments", JSON.stringify(patch.attachments), "::jsonb");
    }
    if (sets.length === 0) return this.getById(id);
    values.push(id);
    const result = await this.db.query<BlockRow>(
      `UPDATE blocks SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  /**
   * Merge a partial state into the block's state (top-level keys replace;
   * an object under a key is merged one level down, so
   * `{ findings: { f1: {...} } }` changes one finding and keeps the rest).
   */
  async mergeState(
    id: string,
    patch: Record<string, unknown>
  ): Promise<Block | null> {
    if (!isBlockId(id)) return null;
    const current = await this.getById(id);
    if (!current) return null;
    const next: Record<string, unknown> = {
      ...((current.state as Record<string, unknown> | null) ?? {}),
    };
    for (const [key, value] of Object.entries(patch)) {
      const prev = next[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        prev &&
        typeof prev === "object" &&
        !Array.isArray(prev)
      ) {
        next[key] = { ...(prev as object), ...(value as object) };
      } else {
        next[key] = value;
      }
    }
    return this.update(id, { state: next });
  }

  /**
   * Set the answer on an unanswered question, atomically: matches nothing
   * when the question already has one, so racing answers leave exactly one.
   */
  async recordAnswer(
    questionId: string,
    answer: BlockActor & { value: string; label?: string; blockId: string }
  ): Promise<Block | null> {
    if (!isBlockId(questionId)) return null;
    const result = await this.db.query<BlockRow>(
      `UPDATE blocks
          SET state = COALESCE(state, '{}'::jsonb) || jsonb_build_object('answer', $2::jsonb),
              updated_at = now()
        WHERE id = $1 AND kind = 'question'
          AND (state IS NULL OR state->'answer' IS NULL)
        RETURNING *`,
      [questionId, JSON.stringify(answer)]
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  /** Set the submission on a form that has none yet; see `recordAnswer`. */
  async recordSubmission(
    formId: string,
    submission: BlockActor & {
      values: Record<string, string | number | boolean>;
      blockId: string;
    }
  ): Promise<Block | null> {
    if (!isBlockId(formId)) return null;
    const result = await this.db.query<BlockRow>(
      `UPDATE blocks
          SET state = COALESCE(state, '{}'::jsonb) || jsonb_build_object('submission', $2::jsonb),
              updated_at = now()
        WHERE id = $1 AND kind = 'form'
          AND (state IS NULL OR state->'submission' IS NULL)
        RETURNING *`,
      [formId, JSON.stringify(submission)]
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  /** Blocks with a recipient: record whether the prompt reached it. */
  async setDelivered(id: string, delivered: boolean): Promise<void> {
    if (!isBlockId(id)) return;
    await this.db.query(`UPDATE blocks SET delivered = $2 WHERE id = $1`, [
      id,
      delivered,
    ]);
  }

  /**
   * Startup recovery: a row still `delivered IS NULL` belongs to a delivery
   * that was waiting in a previous process's in-memory queue and died with
   * it. Mark them all not-delivered so the UI offers a resend instead of
   * showing "pending" forever. Returns the distinct stream ids touched.
   */
  async sweepPendingDeliveries(): Promise<string[]> {
    const result = await this.db.query<{ stream_id: string }>(
      `UPDATE blocks SET delivered = false
        WHERE to_agent_id IS NOT NULL AND delivered IS NULL
        RETURNING stream_id`
    );
    return [...new Set(result.rows.map((row) => row.stream_id))];
  }

  async sweepPendingReactions(): Promise<string[]> {
    const result = await this.db.query<{ stream_id: string }>(
      `UPDATE block_reactions SET delivered = false
        WHERE author_kind = 'user' AND delivered IS NULL
        RETURNING stream_id`
    );
    return [...new Set(result.rows.map((row) => row.stream_id))];
  }

  /** A block's reactions, oldest first — the order the feed lists them in. */
  async listReactions(blockId: string): Promise<BlockReaction[]> {
    if (!isBlockId(blockId)) return [];
    const result = await this.db.query<ReactionRow>(
      `SELECT * FROM block_reactions WHERE block_id = $1 ORDER BY created_at, id`,
      [blockId]
    );
    return result.rows.map(toReaction);
  }

  /**
   * Add one reaction. Returns null when this author already put that emoji
   * on the block — a double click or a second tab raced this one, and the
   * reaction that won is the one that gets delivered.
   */
  async insertReaction(input: {
    streamId: string;
    blockId: string;
    author: BlockAuthor;
    emoji: string;
    delivered: boolean | null;
  }): Promise<BlockReaction | null> {
    const result = await this.db.query<ReactionRow>(
      `INSERT INTO block_reactions
         (id, block_id, stream_id, author_kind, author_agent_id, emoji, delivered)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (block_id, author_kind, author_agent_id, emoji) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.blockId,
        input.streamId,
        input.author.kind,
        input.author.kind === "agent" ? input.author.agentId : null,
        input.emoji,
        input.delivered,
      ]
    );
    return result.rows[0] ? toReaction(result.rows[0]) : null;
  }

  /** Remove one author's reaction; false when it was not there. */
  async deleteReaction(
    blockId: string,
    author: BlockAuthor,
    emoji: string
  ): Promise<boolean> {
    if (!isBlockId(blockId)) return false;
    const result = await this.db.query(
      `DELETE FROM block_reactions
        WHERE block_id = $1 AND author_kind = $2
          AND author_agent_id IS NOT DISTINCT FROM $3 AND emoji = $4`,
      [
        blockId,
        author.kind,
        author.kind === "agent" ? author.agentId : null,
        emoji,
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * How many top-level blocks the block's author has posted on this stream
   * since it — so a reaction envelope can say "your latest post" or "3
   * posts ago". Compared against the stored timestamp, not the millisecond
   * ISO on the wire, which would put a row after itself.
   */
  async countLaterPostsBySameAuthor(blockId: string): Promise<number> {
    if (!isBlockId(blockId)) return 0;
    const result = await this.db.query<{ later: number }>(
      `SELECT COUNT(later.id)::int AS later
         FROM blocks b
         JOIN blocks later
           ON later.stream_id = b.stream_id
          AND later.author_kind = b.author_kind
          AND later.author_agent_id IS NOT DISTINCT FROM b.author_agent_id
          AND later.thread_id IS NULL
          AND (later.created_at, later.id) > (b.created_at, b.id)
        WHERE b.id = $1`,
      [blockId]
    );
    return result.rows[0]?.later ?? 0;
  }

  /** Record whether a reaction's delivery succeeded. */
  async setReactionDelivered(id: string, delivered: boolean): Promise<void> {
    if (!isBlockId(id)) return;
    await this.db.query(
      `UPDATE block_reactions SET delivered = $2 WHERE id = $1`,
      [id, delivered]
    );
  }

  async getById(id: string): Promise<Block | null> {
    if (!isBlockId(id)) return null;
    const result = await this.db.query<BlockRow>(
      `SELECT * FROM blocks WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  /** A thread: its root and every reply, oldest first. */
  async listThread(
    rootId: string
  ): Promise<{ root: Block; replies: Block[] } | null> {
    if (!isBlockId(rootId)) return null;
    const root = await this.getById(rootId);
    if (!root || root.threadId !== null) return null;
    const result = await this.db.query<BlockRow>(
      `SELECT b.*, rx.reactions
         FROM blocks b
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', r.id, 'authorKind', r.author_kind,
                      'authorAgentId', r.author_agent_id, 'emoji', r.emoji,
                      'delivered', r.delivered, 'createdAt', r.created_at)
                    ORDER BY r.created_at, r.id) AS reactions
             FROM block_reactions r WHERE r.block_id = b.id
         ) rx ON true
        WHERE b.thread_id = $1
        ORDER BY b.created_at, b.id`,
      [rootId]
    );
    return { root, replies: result.rows.map(toBlock) };
  }

  /**
   * Everyone who took part in a thread besides `except`: the root's author
   * and every reply's author. Who a reply in the thread is delivered to.
   */
  async threadParticipants(
    rootId: string,
    except: BlockAuthor
  ): Promise<BlockAuthor[]> {
    if (!isBlockId(rootId)) return [];
    // Both sides of every block in the thread: who wrote it and whom it was
    // for. A launch block is written by a person for the child, so the
    // child is a participant of its own launch thread from the start.
    const result = await this.db.query<{
      author_kind: BlockAuthorKind;
      author_agent_id: string | null;
    }>(
      `SELECT DISTINCT author_kind, author_agent_id FROM (
         SELECT author_kind, author_agent_id FROM blocks
          WHERE id = $1 OR thread_id = $1
         UNION
         SELECT 'agent' AS author_kind, to_agent_id AS author_agent_id FROM blocks
          WHERE (id = $1 OR thread_id = $1) AND to_agent_id IS NOT NULL
       ) parties`,
      [rootId]
    );
    return result.rows
      .map((row) => authorOf(row.author_kind, row.author_agent_id))
      .filter((author) => !sameAuthor(author, except));
  }

  /**
   * The block that records what an agent was launched with: the anchor of
   * the thread its parent and it talk in. Null for an agent launched with
   * no context, or before the block is written.
   */
  async findLaunchBlock(agentId: string): Promise<Block | null> {
    const result = await this.db.query<BlockRow>(
      `SELECT * FROM blocks
        WHERE to_agent_id = $1 AND origin = 'launch' AND thread_id IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [agentId]
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  /**
   * Mark unread agent blocks read — up to and including `upTo`, or all of
   * them. Reports what was marked so a client can mirror it on the rows it
   * holds: `readAt` is the stamp written, `upToAt` the bound's created time
   * (null when everything was marked). Both null when nothing changed.
   */
  async markRead(
    streamId: string,
    upTo?: string | null
  ): Promise<{
    updated: number;
    readAt: string | null;
    upToAt: string | null;
  }> {
    const none = { updated: 0, readAt: null, upToAt: null };
    if (upTo != null && !isBlockId(upTo)) return none;
    const result = upTo
      ? await this.db.query<{ read_at: Date; up_to_at: Date }>(
          `UPDATE blocks AS b SET read_at = now()
            FROM blocks AS bound
           WHERE bound.id = $2 AND bound.stream_id = $1
             AND b.stream_id = $1 AND b.author_kind = 'agent'
             AND b.to_agent_id IS NULL AND b.read_at IS NULL
             AND b.created_at <= bound.created_at
           RETURNING b.read_at, bound.created_at AS up_to_at`,
          [streamId, upTo]
        )
      : await this.db.query<{ read_at: Date; up_to_at: null }>(
          `UPDATE blocks SET read_at = now()
            WHERE stream_id = $1 AND author_kind = 'agent'
              AND to_agent_id IS NULL AND read_at IS NULL
           RETURNING read_at, NULL AS up_to_at`,
          [streamId]
        );
    const first = result.rows[0];
    if (!first) return none;
    return {
      updated: result.rowCount ?? result.rows.length,
      readAt: first.read_at.toISOString(),
      upToAt: first.up_to_at ? first.up_to_at.toISOString() : null,
    };
  }

  async countUnread(streamId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM blocks
        WHERE stream_id = $1 AND author_kind = 'agent'
          AND to_agent_id IS NULL AND read_at IS NULL`,
      [streamId]
    );
    return Number(result.rows[0].count);
  }

  /**
   * Unread and open-input counts for every non-deleted agent that has a
   * non-zero value — one grouped query, for the sidebar badges.
   */
  async unreadSummary(): Promise<ChatUnreadSummary> {
    const result = await this.db.query<{
      stream_id: string;
      unread: string;
      pending: string;
    }>(
      `SELECT b.stream_id,
              COUNT(*) FILTER (WHERE b.read_at IS NULL)::text AS unread,
              COUNT(*) FILTER (WHERE ${OPEN_INPUT_SQL})::text AS pending
         FROM blocks b
         JOIN agents a ON a.id = b.stream_id AND a.deleted_at IS NULL
        WHERE b.author_kind = 'agent' AND b.to_agent_id IS NULL
          AND (b.read_at IS NULL OR ${OPEN_INPUT_SQL})
        GROUP BY b.stream_id`
    );
    const agents: ChatUnreadSummary["agents"] = {};
    for (const row of result.rows) {
      agents[row.stream_id] = {
        unread: Number(row.unread),
        pendingQuestions: Number(row.pending),
      };
    }
    return { agents };
  }

  /**
   * The newest open input block (question or form) the agent posted for
   * people: what the agent is waiting on. Null when it is not waiting.
   */
  async openInput(agentId: string): Promise<Block | null> {
    const result = await this.db.query<BlockRow>(
      `SELECT * FROM blocks b
        WHERE b.author_kind = 'agent' AND b.author_agent_id = $1
          AND b.to_agent_id IS NULL AND ${OPEN_INPUT_SQL}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 1`,
      [agentId]
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }
}

/** A question with no answer or a form with no submission (alias `b`). */
export const OPEN_INPUT_SQL = `(b.kind IN ('question', 'form')
          AND (b.state IS NULL OR (b.state->'answer' IS NULL AND b.state->'submission' IS NULL)))`;
