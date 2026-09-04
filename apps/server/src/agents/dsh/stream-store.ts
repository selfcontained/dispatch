import type { Queryable } from "../../chat/store.js";

export type StreamEventKind = "assistant" | "thought" | "tool_call" | "status";

/** Payload shapes by row kind. The recorder writes them; the Chat feed reads them. */
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
};
export type StatusPayload = { message: string };
export type StreamPayloadByKind = {
  assistant: AssistantPayload;
  thought: ThoughtPayload;
  tool_call: ToolPayload;
  status: StatusPayload;
};

export type StreamEventRow = {
  id: number;
  agentId: string;
  seq: number;
  kind: StreamEventKind;
  /** toolCallId for tool_call rows; null for everything else. */
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
 * harness (dsh over ACP) that the Chat feed reads. Append-only except for
 * tool calls, which are rewritten in place under their toolCallId.
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
