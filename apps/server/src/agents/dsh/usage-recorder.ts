import type { Queryable } from "../../chat/store.js";
import type { DriverEvent } from "./driver.js";

/**
 * ACP reports cumulative session usage on each prompt response, so every
 * settled turn rewrites the totals for (agent, session, model) and bumps the
 * turn count. Same table and conflict key the log-scraping harvester uses
 * for Claude and Codex, so the token panel needs no new query.
 */
const UPSERT_SQL = `INSERT INTO agent_token_usage
  (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens,
   output_tokens, message_count, session_start, session_end)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())
 ON CONFLICT (agent_id, session_id, model)
 DO UPDATE SET
   input_tokens = EXCLUDED.input_tokens,
   cache_creation_tokens = EXCLUDED.cache_creation_tokens,
   cache_read_tokens = EXCLUDED.cache_read_tokens,
   output_tokens = EXCLUDED.output_tokens,
   message_count = agent_token_usage.message_count + 1,
   session_end = NOW(),
   harvested_at = NOW()`;

export class UsageRecorder {
  constructor(private readonly db: Queryable) {}

  async handle(
    event: DriverEvent,
    ctx: { sessionId: string; model: string }
  ): Promise<void> {
    if (event.type !== "turn" || event.state !== "settled" || !event.usage) {
      return;
    }
    const u = event.usage;
    await this.db.query(UPSERT_SQL, [
      event.agentId,
      ctx.sessionId,
      ctx.model,
      u.inputTokens ?? 0,
      u.cachedWriteTokens ?? 0,
      u.cachedReadTokens ?? 0,
      u.outputTokens ?? 0,
    ]);
  }
}
