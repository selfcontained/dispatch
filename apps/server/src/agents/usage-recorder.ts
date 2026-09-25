import type { Pool } from "pg";

import type { DriverUsage } from "./acp/driver.js";

/**
 * A settled turn's token counts, added to the agent's row for its session
 * and model in `agent_token_usage` (the table the Activity token views read).
 *
 * The prompt response's usage is the turn's, not the session's: Claude's
 * adapter resets its tally when a turn starts, and Codex's reports the turn's
 * last model call. So each turn adds; nothing is overwritten. A model switched
 * mid-session starts its own row and the earlier model keeps what it spent.
 */
const ADD_SQL = `INSERT INTO agent_token_usage
  (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens,
   output_tokens, message_count, session_start, session_end)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())
 ON CONFLICT (agent_id, session_id, model)
 DO UPDATE SET
   input_tokens = agent_token_usage.input_tokens + EXCLUDED.input_tokens,
   cache_creation_tokens = agent_token_usage.cache_creation_tokens + EXCLUDED.cache_creation_tokens,
   cache_read_tokens = agent_token_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
   output_tokens = agent_token_usage.output_tokens + EXCLUDED.output_tokens,
   message_count = agent_token_usage.message_count + 1,
   session_end = NOW(),
   harvested_at = NOW()`;

const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;

export async function recordTurnUsage(
  pool: Pick<Pool, "query">,
  input: {
    agentId: string;
    sessionId: string;
    model: string;
    usage: DriverUsage;
  }
): Promise<void> {
  const u = input.usage;
  const tokens = [
    count(u.inputTokens),
    count(u.cachedWriteTokens),
    count(u.cachedReadTokens),
    // Reasoning tokens are part of output already (thoughtTokens is a breakdown).
    count(u.outputTokens),
  ];
  if (tokens.every((t) => t === 0)) return;
  await pool.query(ADD_SQL, [
    input.agentId,
    input.sessionId,
    input.model,
    ...tokens,
  ]);
}
