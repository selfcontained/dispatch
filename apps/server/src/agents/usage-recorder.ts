import type { Pool } from "pg";

/**
 * Bring `agent_token_usage` (the table the Activity token views read) up to
 * date with the agent's newest settled turn.
 *
 * Each turn row keeps its own tokens, session and model (the recorder writes
 * them; the adapters report per-turn usage, not session totals). The row for
 * that turn's (agent, session, model) is recomputed as the sum over those
 * turn rows, never incremented, so a settle event replayed after a restart
 * changes nothing, and a model switched mid-turn does not take the turn's
 * tokens: the turn is counted under the model it started on.
 */
const SYNC_SQL = `
  WITH newest AS (
    SELECT payload->>'sessionId' AS session_id,
           COALESCE(payload->>'model', 'default') AS model
      FROM agent_stream_events
     WHERE agent_id = $1 AND kind = 'turn'
       AND payload ? 'tokens' AND payload ? 'sessionId'
     ORDER BY seq DESC
     LIMIT 1
  )
  INSERT INTO agent_token_usage
    (agent_id, session_id, model, input_tokens, cache_creation_tokens,
     cache_read_tokens, output_tokens, message_count, session_start, session_end)
  SELECT $1, n.session_id, n.model,
         SUM((e.payload->'tokens'->>'input')::bigint),
         SUM((e.payload->'tokens'->>'cacheWrite')::bigint),
         SUM((e.payload->'tokens'->>'cacheRead')::bigint),
         SUM((e.payload->'tokens'->>'output')::bigint),
         COUNT(*),
         MIN(e.created_at),
         MAX(e.updated_at)
    FROM newest n
    JOIN agent_stream_events e
      ON e.agent_id = $1 AND e.kind = 'turn' AND e.payload ? 'tokens'
     AND e.payload->>'sessionId' = n.session_id
     AND COALESCE(e.payload->>'model', 'default') = n.model
   GROUP BY n.session_id, n.model
  ON CONFLICT (agent_id, session_id, model)
  DO UPDATE SET
    input_tokens = EXCLUDED.input_tokens,
    cache_creation_tokens = EXCLUDED.cache_creation_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    output_tokens = EXCLUDED.output_tokens,
    message_count = EXCLUDED.message_count,
    session_start = EXCLUDED.session_start,
    session_end = EXCLUDED.session_end,
    harvested_at = NOW()`;

export async function syncTurnUsage(
  pool: Pick<Pool, "query">,
  agentId: string
): Promise<void> {
  await pool.query(SYNC_SQL, [agentId]);
}
