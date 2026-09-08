import {
  HARNESS_ENGINES,
  harnessEngineOf,
  type HarnessUsageAgent,
  type HarnessUsageEngine,
  type HarnessUsageReport,
  type UsageBudgets,
} from "@dispatch/shared";

import type { Queryable } from "../../chat/store.js";

/**
 * What the harness engines have used this month. Tokens come from
 * `agent_token_usage`, which the usage recorder fills from each prompt
 * response's cumulative counts. Cost comes from the newest turn row that
 * carries a `usage.cost`: an engine reports its running total for the
 * current session, so this is the current session's spend, and a session
 * the agent ran earlier in the month is not added to it.
 */

export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type AgentRow = {
  id: string;
  name: string;
  model: string | null;
  tokens: string | number;
  cost_amount: string | number | null;
  cost_currency: string | null;
};

const AGENTS_SQL = `
  WITH tokens AS (
    SELECT agent_id,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM agent_token_usage
     WHERE session_end >= $1
     GROUP BY agent_id
  ),
  cost AS (
    SELECT DISTINCT ON (agent_id) agent_id,
           (payload->'usage'->'cost'->>'amount')::float8 AS amount,
           payload->'usage'->'cost'->>'currency' AS currency
      FROM agent_stream_events
     WHERE kind = 'turn' AND created_at >= $1
       AND payload->'usage'->'cost' IS NOT NULL
     ORDER BY agent_id, seq DESC
  )
  SELECT a.id, a.name, a.model,
         COALESCE(t.tokens, 0) AS tokens,
         c.amount AS cost_amount, c.currency AS cost_currency
    FROM agents a
    LEFT JOIN tokens t ON t.agent_id = a.id
    LEFT JOIN cost c ON c.agent_id = a.id
   WHERE a.type = 'dispatch' AND a.deleted_at IS NULL`;

function toAgent(row: AgentRow): HarnessUsageAgent {
  return {
    agentId: row.id,
    name: row.name,
    tokens: Number(row.tokens),
    costUsd:
      row.cost_amount !== null && row.cost_currency === "USD"
        ? Number(row.cost_amount)
        : null,
  };
}

export async function loadUsageReport(
  db: Queryable,
  budgets: UsageBudgets,
  now: Date = new Date()
): Promise<HarnessUsageReport> {
  const monthStart = monthStartUtc(now);
  const result = await db.query<AgentRow>(`${AGENTS_SQL} ORDER BY a.name`, [
    monthStart,
  ]);
  const engines: HarnessUsageEngine[] = HARNESS_ENGINES.map((engine) => ({
    ...engine,
    tokens: 0,
    costUsd: null,
    budgetUsd: engine.reportsCost ? (budgets[engine.id] ?? null) : null,
    agents: [],
  }));
  for (const row of result.rows) {
    // A row with no model counts under the default engine, which is the
    // engine its child runs; null here is only an unknown engine id.
    const engine = harnessEngineOf(row.model);
    if (!engine) continue;
    const bucket = engines.find((e) => e.id === engine.id);
    if (!bucket) continue;
    const agent = toAgent(row);
    bucket.agents.push(agent);
    bucket.tokens += agent.tokens;
    if (agent.costUsd !== null) {
      bucket.costUsd = (bucket.costUsd ?? 0) + agent.costUsd;
    }
  }
  return {
    generatedAt: now.toISOString(),
    monthStart: monthStart.toISOString(),
    engines,
  };
}

export async function loadAgentUsage(
  db: Queryable,
  agentId: string,
  now: Date = new Date()
): Promise<HarnessUsageAgent | null> {
  const result = await db.query<AgentRow>(`${AGENTS_SQL} AND a.id = $2`, [
    monthStartUtc(now),
    agentId,
  ]);
  const row = result.rows[0];
  return row ? toAgent(row) : null;
}
