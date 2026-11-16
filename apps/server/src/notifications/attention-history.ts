import type { AttentionHistoryItem } from "@dispatch/shared";
import type { Pool } from "pg";

/** Match the attention text emitted by AgentManager, including blank-input fallbacks. */
function summary(text: string): string {
  const line =
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Source records only, independent of delivery. Negative seq keeps these out
 * of engine turn ranges and avoids contending with the recorder's positive seq. */
export class AttentionHistory {
  private pending = new Map<string, Promise<void>>();
  constructor(
    private pool: Pool,
    private logger: {
      warn: (obj: Record<string, unknown>, message: string) => void;
    },
    private changed: () => void = () => {}
  ) {}
  private enqueue(agentId: string, write: () => Promise<boolean>): void {
    const next = (this.pending.get(agentId) ?? Promise.resolve())
      .then(write)
      .then((changed) => {
        if (changed) this.changed();
      })
      .catch((err) =>
        this.logger.warn({ err, agentId }, "Could not record attention history")
      );
    this.pending.set(agentId, next);
    void next.then(() => {
      if (this.pending.get(agentId) === next) this.pending.delete(agentId);
    });
  }
  permissions(
    agentId: string,
    requests: readonly { id: string; title: string }[]
  ): void {
    this.enqueue(agentId, async () => {
      const cleared = await this.pool.query(
        `UPDATE agent_stream_events SET payload=payload || '{"settled":true}'::jsonb, updated_at=now()
        WHERE agent_id=$1 AND kind='attention' AND payload->>'attentionKind'='approval'
        AND NOT (payload->>'requestId'=ANY($2::text[])) AND payload->>'settled'='false'`,
        [agentId, requests.map((r) => r.id)]
      );
      let changed = !!cleared.rowCount;
      for (const request of requests) {
        const result = await this.pool.query(
          `INSERT INTO agent_stream_events(agent_id,seq,kind,key,payload)
          SELECT $1,LEAST(COALESCE(MIN(seq),0),0)-1,'attention',$2,$3::jsonb FROM agent_stream_events WHERE agent_id=$1
          ON CONFLICT (agent_id,kind,key) WHERE key IS NOT NULL DO NOTHING`,
          [
            agentId,
            `approval:${request.id}`,
            JSON.stringify({
              attentionKind: "approval",
              requestId: request.id,
              message: `Approval needed: ${summary(request.title)}`,
              settled: false,
            }),
          ]
        );
        changed = changed || !!result.rowCount;
      }
      return changed;
    });
  }
  blocked(agentId: string, message: string): void {
    this.enqueue(agentId, async () => {
      await this.settleBlockedRows(agentId);
      await this.pool.query(
        `INSERT INTO agent_stream_events(agent_id,seq,kind,payload)
        SELECT $1,LEAST(COALESCE(MIN(seq),0),0)-1,'attention',$2::jsonb FROM agent_stream_events WHERE agent_id=$1`,
        [
          agentId,
          JSON.stringify({ attentionKind: "blocked", message, settled: false }),
        ]
      );
      return true;
    });
  }
  private async settleBlockedRows(agentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_stream_events SET payload=payload || '{"settled":true}'::jsonb,updated_at=now()
      WHERE agent_id=$1 AND kind='attention' AND payload->>'attentionKind'='blocked' AND payload->>'settled'='false'`,
      [agentId]
    );
    return !!result.rowCount;
  }
  settleBlocked(agentId: string): void {
    this.enqueue(agentId, () => this.settleBlockedRows(agentId));
  }
  async idle(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}
export async function listAttentionHistory(
  pool: Pool
): Promise<AttentionHistoryItem[]> {
  const { rows } = await pool.query(`SELECT * FROM (
   SELECT 'block:'||b.id AS id,b.author_agent_id AS agent_id,COALESCE(a.name,b.author_agent_id) AS agent_name,
     b.kind,COALESCE(NULLIF(b.text,''), CASE WHEN b.kind='form' THEN COALESCE(b.data->>'title','Form')
       ELSE (SELECT string_agg(option->>'label',' / ' ORDER BY ordinal) FROM jsonb_array_elements(COALESCE(b.data->'options','[]'::jsonb)) WITH ORDINALITY AS options(option,ordinal)) END) AS message,b.created_at,b.stream_id,b.thread_id,b.id::text AS block_id,
     (b.state ? 'cancellation' OR CASE WHEN b.kind='question' THEN b.state ? 'answer' ELSE b.state ? 'submission' END) AS settled
   FROM blocks b JOIN agents a ON a.id=b.author_agent_id
   WHERE b.author_kind='agent' AND b.to_agent_id IS NULL AND b.kind IN ('question','form') AND b.created_at>=now()-interval '7 days'
   UNION ALL
   SELECT 'event:'||e.id,e.agent_id,COALESCE(a.name,e.agent_id),e.payload->>'attentionKind',e.payload->>'message',e.created_at,
     NULL::text,NULL::uuid,NULL::text,COALESCE((e.payload->>'settled')::boolean,false)
   FROM agent_stream_events e JOIN agents a ON a.id=e.agent_id
   WHERE e.kind='attention' AND e.payload->>'attentionKind' IN ('approval','blocked') AND e.created_at>=now()-interval '7 days'
 ) items ORDER BY created_at DESC,id DESC LIMIT 50`);
  return rows.map((row) => ({
    type: "attention.toast",
    toastId: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    kind: row.kind,
    message:
      row.kind === "question" || row.kind === "form"
        ? summary(row.message ?? "")
        : row.message,
    createdAt: new Date(row.created_at).toISOString(),
    settled: row.settled ?? false,
    target: row.block_id
      ? {
          streamId: row.stream_id,
          threadId: row.thread_id,
          blockId: row.block_id,
        }
      : null,
  }));
}
