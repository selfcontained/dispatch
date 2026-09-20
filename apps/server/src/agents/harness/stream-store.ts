import type { Queryable } from "../../chat/store.js";
import type { PromptSource } from "./prompt-source.js";

export type StreamEventKind =
  | "assistant"
  | "thought"
  | "tool_call"
  | "status"
  | "turn"
  | "plan";

export type AssistantPayload = {
  text: string;
  streaming: boolean;
  /** Set when the text hit the per-row size bound. */
  truncated?: boolean;
};
export type ThoughtPayload = { text: string; truncated?: boolean };
export type ToolPayload = {
  /** Agent Client Protocol tool kind (read, edit, execute, ...) or "other". */
  toolKind: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
  /** Set when terminal output or the diff hit the per-row size bound. */
  truncated?: boolean;
  /** Raw tool input from the stream (`rawInput`), bounded; see boundInput. */
  input?: unknown;
  /** A nested call: the toolCallId of the step it runs under (a subagent's parent). */
  parentToolCallId?: string;
  /** Why the call never reported: set when a cut settled it, not by the engine. */
  error?: string;
};
export type PlanPayload = {
  entries: { content: string; status: string; priority: string }[];
};
export type TurnPayload = {
  state: "started" | "settled";
  prompt: PromptSource;
  /**
   * The engine started this turn itself (a goal round), so no prompt from
   * Dispatch opened it and no prompt response closes it.
   */
  autonomous?: boolean;
  stopReason?: string;
  error?: string;
  endedAt?: string;
  /** The engine's last usage_update in this turn: context used and, when reported, cost so far. */
  usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
};

export type StreamEventRow = {
  id: number;
  agentId: string;
  seq: number;
  kind: StreamEventKind;
  key: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string | number;
  agent_id: string;
  seq: number;
  kind: StreamEventKind;
  key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

function toRow(r: Row): StreamEventRow {
  return {
    id: Number(r.id),
    agentId: r.agent_id,
    seq: r.seq,
    kind: r.kind,
    key: r.key,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const INSERT_SQL = `
  INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
  SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4::jsonb
    FROM agent_stream_events
   WHERE agent_id = $1
  RETURNING *`;

/**
 * Turn every `in_progress` entry of the agent's plan rows after `$2` back to
 * `pending`, leaving order and every other field alone.
 */
const DEMOTE_PLAN_SQL = `
  UPDATE agent_stream_events
     SET payload = jsonb_set(
           payload,
           '{entries}',
           (SELECT COALESCE(
                     jsonb_agg(
                       CASE WHEN e->>'status' = 'in_progress'
                            THEN e || '{"status":"pending"}'::jsonb
                            ELSE e END
                       ORDER BY ord),
                     '[]'::jsonb)
              FROM jsonb_array_elements(payload->'entries')
                   WITH ORDINALITY AS t(e, ord))),
         updated_at = NOW()
   WHERE agent_id = $1 AND kind = 'plan' AND seq > $2
     AND payload->'entries' @> '[{"status":"in_progress"}]'::jsonb`;

/**
 * Rows in `agent_stream_events`: the durable projection of a stream-driven
 * harness (an engine over ACP) that the Chat feed reads. Append-only except for
 * tool calls and plans, which are rewritten in place under their key.
 */
export class StreamStore {
  constructor(private readonly db: Queryable) {}

  async append(
    agentId: string,
    kind: StreamEventKind,
    payload: Record<string, unknown>,
    key: string | null = null
  ): Promise<StreamEventRow> {
    const result = await this.db.query<Row>(INSERT_SQL, [
      agentId,
      kind,
      key,
      JSON.stringify(payload),
    ]);
    return toRow(result.rows[0]);
  }

  async getByKey(
    agentId: string,
    kind: StreamEventKind,
    key: string
  ): Promise<StreamEventRow | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events
        WHERE agent_id = $1 AND kind = $2 AND key = $3`,
      [agentId, kind, key]
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async upsertByKey(
    agentId: string,
    kind: StreamEventKind,
    key: string,
    payload: Record<string, unknown>
  ): Promise<StreamEventRow> {
    const existing = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events
        WHERE agent_id = $1 AND kind = $2 AND key = $3`,
      [agentId, kind, key]
    );
    const found = existing.rows[0];
    if (found) {
      const updated = await this.db.query<Row>(
        `UPDATE agent_stream_events
            SET payload = $2::jsonb, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [found.id, JSON.stringify(payload)]
      );
      return toRow(updated.rows[0]);
    }
    return this.append(agentId, kind, payload, key);
  }

  async updatePayload(
    id: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_stream_events
          SET payload = $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(payload)]
    );
  }

  /**
   * Settle whatever a dead child left open: a turn still `started` gets
   * `settled` with the given error, an assistant row still streaming stops,
   * and a tool call still pending or in progress is failed. Run before a
   * session (re)starts, so a turn cut off by a crash, a Stop, or a server
   * restart never spins in the view forever.
   */
  async settleInterrupted(agentId: string, error: string): Promise<number> {
    const turns = await this.db.query(
      `UPDATE agent_stream_events
          SET payload = payload || $2::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'turn'
          AND payload->>'state' = 'started'`,
      [
        agentId,
        JSON.stringify({
          state: "settled",
          error,
          endedAt: new Date().toISOString(),
        }),
      ]
    );
    await this.db.query(
      `UPDATE agent_stream_events
          SET payload = payload || '{"streaming":false}'::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'assistant'
          AND payload->>'streaming' = 'true'`,
      [agentId]
    );
    // A tool call the cut left open has nobody to report its result: the
    // engine that ran it is gone. Without this the feed projects a step that
    // runs forever, since `toolStep` reads anything unfinished as "running".
    // `failed` because it never reported success — which is not the same as
    // never having run. A call cut mid-flight may well have landed its side
    // effects, so the error is carried for whoever reads back.
    await this.db.query(
      `UPDATE agent_stream_events
          SET payload = payload || $2::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'tool_call'
          AND payload->>'status' IN ('pending', 'in_progress')`,
      [agentId, JSON.stringify({ status: "failed", error })]
    );
    // Nothing is in progress once the engine is gone. The list itself is
    // kept: the work it names is still to do, it is just not being done.
    await this.db.query(DEMOTE_PLAN_SQL, [agentId, -1]);
    return turns.rowCount ?? 0;
  }

  /**
   * Settle what a turn that has just ended left open, for the rows it owns
   * (everything after `turnSeq`; see `turnAnchorForMessage` on ownership).
   *
   * A tool call still `pending` or `in_progress` will never hear from the
   * engine through this turn, and `toolStep` reads anything unfinished as
   * "running", so it would spin in a turn that reads as over. It settles to
   * `failed` with the reason. A late report still wins: `tool_call_update`
   * rewrites the row, and the reason goes with it.
   *
   * A task marked `in_progress` goes back to `pending`. The agent is the
   * only writer of its list and it stops writing when the turn ends, so an
   * active task would otherwise stay active for as long as the agent idles.
   */
  async settleTurnLeftovers(
    agentId: string,
    turnSeq: number,
    error: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_stream_events
          SET payload = payload || $3::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'tool_call' AND seq > $2
          AND payload->>'status' IN ('pending', 'in_progress')`,
      [agentId, turnSeq, JSON.stringify({ status: "failed", error })]
    );
    await this.db.query(DEMOTE_PLAN_SQL, [agentId, turnSeq]);
  }

  /**
   * The turn a Chat message started, open or settled, and where the turn
   * after it begins (null when it is the newest).
   *
   * Grouping is positional (`groupTurnRows`): a turn row owns every row
   * after it until the next turn row. So `seq` is the lower bound of what
   * the turn produced and `nextSeq` the upper one.
   *
   * Looked up by the message, not by "the newest open turn": between a
   * cancel and the read that follows it the turn may already have settled,
   * and a queued prompt may already have opened the next one. Either makes
   * "newest open" name the wrong turn, or none.
   */
  async turnAnchorForMessage(
    agentId: string,
    chatMessageId: string
  ): Promise<{ seq: number; nextSeq: number | null } | null> {
    const result = await this.db.query<{
      seq: number;
      next_seq: number | null;
    }>(
      `SELECT t.seq,
              (SELECT MIN(n.seq) FROM agent_stream_events n
                WHERE n.agent_id = t.agent_id AND n.kind = 'turn'
                  AND n.seq > t.seq) AS next_seq
         FROM agent_stream_events t
        WHERE t.agent_id = $1 AND t.kind = 'turn'
          AND t.payload->'prompt'->>'chatMessageId' = $2
        ORDER BY t.seq DESC LIMIT 1`,
      [agentId, chatMessageId]
    );
    const row = result.rows[0];
    return row ? { seq: row.seq, nextSeq: row.next_seq } : null;
  }

  /** Drop the rows in `[fromSeq, beforeSeq)`, or from `fromSeq` on. Returns how many went. */
  async deleteRange(
    agentId: string,
    fromSeq: number,
    beforeSeq: number | null
  ): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM agent_stream_events
        WHERE agent_id = $1 AND seq >= $2
          AND ($3::int IS NULL OR seq < $3::int)`,
      [agentId, fromSeq, beforeSeq]
    );
    return result.rowCount ?? 0;
  }

  /** How the agent's newest turn ended: its error, if any, and when. */
  async lastTurnSettlement(
    agentId: string
  ): Promise<{ error: string | null; endedAt: string | null } | null> {
    const result = await this.db.query<{
      error: string | null;
      ended_at: string | null;
    }>(
      `SELECT payload->>'error' AS error, payload->>'endedAt' AS ended_at
         FROM agent_stream_events
        WHERE agent_id = $1 AND kind = 'turn'
        ORDER BY seq DESC LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    return row ? { error: row.error, endedAt: row.ended_at } : null;
  }

  /** Newest first. */
  async list(agentId: string, limit: number): Promise<StreamEventRow[]> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events
        WHERE agent_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [agentId, limit]
    );
    return result.rows.map(toRow);
  }
}
