import type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentUsageResponse,
  TokenCounts,
} from "@dispatch/shared";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Pool } from "pg";

/** The engine's select options, flattened for the picker; other kinds are skipped. */
export function toAgentConfigOptions(
  options: readonly SessionConfigOption[]
): AgentConfigOption[] {
  const out: AgentConfigOption[] = [];
  for (const option of options) {
    if (option.type !== "select") continue;
    const choices: AgentConfigChoice[] = [];
    const add = (
      o: { value: string; name: string; description?: string | null },
      group?: string
    ) =>
      choices.push({
        value: o.value,
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        ...(group ? { group } : {}),
      });
    for (const entry of option.options) {
      if ("group" in entry) entry.options.forEach((o) => add(o, entry.name));
      else add(entry);
    }
    out.push({
      id: option.id,
      name: option.name,
      category: option.category ?? null,
      currentValue: String(option.currentValue),
      choices,
    });
  }
  return out;
}

export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type TokenRow = {
  model: string;
  input: string | number;
  output: string | number;
  cache_read: string | number;
  cache_write: string | number;
};

function counts(row: Omit<TokenRow, "model"> | undefined): TokenCounts {
  const input = Number(row?.input ?? 0);
  const output = Number(row?.output ?? 0);
  const cacheRead = Number(row?.cache_read ?? 0);
  const cacheWrite = Number(row?.cache_write ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

const SUMS = `COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_write`;

/**
 * What one agent has used: the current session's newest context report and
 * cost, its per-model totals for the session from `agent_token_usage`, and
 * the month's tokens summed turn by turn.
 */
export async function loadAgentUsage(
  pool: Pick<Pool, "query">,
  agent: { id: string; cliSessionId: string | null },
  now: Date = new Date()
): Promise<AgentUsageResponse> {
  const [latest, session, month] = await Promise.all([
    pool.query<{
      used: string | null;
      size: string | null;
      cost_amount: string | null;
      cost_currency: string | null;
    }>(
      `SELECT payload->'usage'->>'used' AS used,
              payload->'usage'->>'size' AS size,
              payload->'usage'->'cost'->>'amount' AS cost_amount,
              payload->'usage'->'cost'->>'currency' AS cost_currency
         FROM agent_stream_events
        WHERE agent_id = $1 AND kind = 'turn' AND payload ? 'usage'
          AND payload->>'sessionId' = $2
        ORDER BY seq DESC
        LIMIT 1`,
      [agent.id, agent.cliSessionId ?? ""]
    ),
    pool.query<TokenRow>(
      `SELECT model, ${SUMS}
         FROM agent_token_usage
        WHERE agent_id = $1 AND session_id = $2
        GROUP BY model`,
      [agent.id, agent.cliSessionId ?? ""]
    ),
    // A session can span months, so the month is summed per turn, by
    // when each turn started, not from the per-session rows.
    pool.query<Omit<TokenRow, "model">>(
      `SELECT COALESCE(SUM((payload->'tokens'->>'input')::bigint), 0) AS input,
              COALESCE(SUM((payload->'tokens'->>'output')::bigint), 0) AS output,
              COALESCE(SUM((payload->'tokens'->>'cacheRead')::bigint), 0) AS cache_read,
              COALESCE(SUM((payload->'tokens'->>'cacheWrite')::bigint), 0) AS cache_write
         FROM agent_stream_events
        WHERE agent_id = $1 AND kind = 'turn' AND payload ? 'tokens'
          AND created_at >= $2`,
      [agent.id, monthStartUtc(now)]
    ),
  ]);

  const row = latest.rows[0];
  const used = Number(row?.used);
  const size = Number(row?.size);
  const amount = Number(row?.cost_amount);
  const byModel = session.rows
    .map((r) => ({ model: r.model, tokens: counts(r) }))
    .sort((a, b) => b.tokens.total - a.tokens.total);
  const sessionTotals = byModel.reduce<TokenCounts>(
    (sum, m) => ({
      input: sum.input + m.tokens.input,
      output: sum.output + m.tokens.output,
      cacheRead: sum.cacheRead + m.tokens.cacheRead,
      cacheWrite: sum.cacheWrite + m.tokens.cacheWrite,
      total: sum.total + m.tokens.total,
    }),
    counts(undefined)
  );
  return {
    context:
      Number.isFinite(used) && Number.isFinite(size) && size > 0
        ? { used, size }
        : null,
    sessionCost:
      row?.cost_currency && Number.isFinite(amount)
        ? { amount, currency: row.cost_currency }
        : null,
    session: sessionTotals,
    month: counts(month.rows[0]),
    byModel,
  };
}
