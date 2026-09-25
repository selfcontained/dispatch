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
};
export type PlanPayload = {
  entries: { content: string; status: string; priority: string }[];
};
/**
 * Where a failed turn's retry stands. `open` is offered on the turn; it
 * becomes `retried` when the user takes it and `closed` when a later turn
 * starts, since by then the conversation has moved past the failure.
 */
export type TurnRetryState = "open" | "retried" | "closed";

export type TurnPayload = {
  state: "started" | "settled";
  prompt: PromptSource;
  /** The model the turn ran on, as the engine published it at the start. */
  model?: string;
  stopReason?: string;
  error?: string;
  /** The adapter's category for `error`, when it gave one. */
  errorKind?: string;
  /** Set on a failed turn a later attempt could clear. */
  retry?: TurnRetryState;
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
   * A new turn starting ends any retry still offered on an earlier one:
   * the conversation has moved past that failure. Returns the rows it
   * closed so their entries can be republished without the offer.
   */
  async closeOpenRetries(agentId: string): Promise<StreamEventRow[]> {
    const result = await this.db.query<Row>(
      `UPDATE agent_stream_events
          SET payload = payload || '{"retry":"closed"}'::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'turn'
          AND payload->>'retry' = 'open'
        RETURNING *`,
      [agentId]
    );
    return result.rows.map(toRow);
  }

  /**
   * Take the retry offered on one turn. Only one caller wins: a second
   * click, or a turn that started in between, finds it no longer open.
   */
  async takeRetry(
    agentId: string,
    turnId: number
  ): Promise<StreamEventRow | null> {
    const result = await this.db.query<Row>(
      `UPDATE agent_stream_events
          SET payload = payload || '{"retry":"retried"}'::jsonb, updated_at = NOW()
        WHERE id = $1 AND agent_id = $2 AND kind = 'turn'
          AND payload->>'retry' = 'open'
        RETURNING *`,
      [turnId, agentId]
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  /** Offer the retry again after a retry that could not be sent. */
  async reopenRetry(agentId: string, turnId: number): Promise<void> {
    await this.db.query(
      `UPDATE agent_stream_events
          SET payload = payload || '{"retry":"open"}'::jsonb, updated_at = NOW()
        WHERE id = $1 AND agent_id = $2 AND kind = 'turn'
          AND payload->>'retry' = 'retried'`,
      [turnId, agentId]
    );
  }

  /**
   * Settle whatever a dead child left open: a turn still `started` gets
   * `settled` with the given error, and an assistant row still streaming
   * stops. Run before a session (re)starts, so a turn cut off by a crash,
   * a Stop, or a server restart never spins in the view forever.
   */
  async settleInterrupted(
    agentId: string,
    error: string
  ): Promise<StreamEventRow[]> {
    const turns = await this.db.query<Row>(
      `UPDATE agent_stream_events
          SET payload = payload || $2::jsonb, updated_at = NOW()
        WHERE agent_id = $1 AND kind = 'turn'
          AND payload->>'state' = 'started'
        RETURNING *`,
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
    return turns.rows.map(toRow);
  }

  /** The agent's newest turn row when it is still open; null otherwise. */
  async openTurn(agentId: string): Promise<StreamEventRow | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events
        WHERE agent_id = $1 AND kind = 'turn'
        ORDER BY seq DESC LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    if (!row || (row.payload as { state?: string }).state !== "started") {
      return null;
    }
    return toRow(row);
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
