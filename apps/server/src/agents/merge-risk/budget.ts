import type { Pool, PoolClient } from "pg";

/** Provider calls per UTC day, shared by automatic assessments and explanations. */
export function mergeRiskDailyCap(env: NodeJS.ProcessEnv) {
  const raw = Number(env.DISPATCH_MERGE_RISK_DAILY_CAP ?? 25);
  return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : 0;
}

/** The daily window resets at 00:00 UTC. */
export function mergeRiskDailyReset(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
}

/** Caller owns a transaction and must reserve its pending record before commit. */
export async function mergeRiskCapacity(
  client: PoolClient,
  env: NodeJS.ProcessEnv
) {
  const cap = mergeRiskDailyCap(env);
  await client.query("SELECT pg_advisory_xact_lock(719394023)");
  await client.query(
    "UPDATE merge_risk_decision_records SET status='interrupted' WHERE status='pending' AND created_at < now() - interval '2 minutes'"
  );
  await client.query(
    "UPDATE merge_risk_explanations SET status='interrupted' WHERE status='pending' AND created_at < now() - interval '2 minutes'"
  );
  await client.query(
    "INSERT INTO merge_risk_decision_daily(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING"
  );
  const daily = await client.query<{ calls: number }>(
    "SELECT calls FROM merge_risk_decision_daily WHERE day=(now() AT TIME ZONE 'UTC')::date"
  );
  const pending = await client.query(
    "SELECT 1 FROM merge_risk_decision_records WHERE status='pending' UNION ALL SELECT 1 FROM merge_risk_explanations WHERE status='pending' LIMIT 2"
  );
  return daily.rows[0]!.calls >= cap
    ? "skipped_daily_cap"
    : pending.rowCount! >= 2
      ? "skipped_concurrency"
      : "pending";
}

/** 401/403/429: refused before any billable work, so not charged. */
export function refusedByProvider(httpStatus: number | undefined) {
  return httpStatus === 401 || httpStatus === 403 || httpStatus === 429;
}

/**
 * Return a reserved call that never reached the provider (stale head, setting
 * changed, evidence unavailable) or that the provider refused (401/403/429).
 * Calls that were sent, including timeouts
 * and unknown outcomes, stay counted. Charged to the reservation's own day.
 */
export async function refundUnsentCall(
  pool: Pool,
  table: "merge_risk_decision_records" | "merge_risk_explanations",
  id: string
) {
  const key = table === "merge_risk_explanations" ? "assessment_id" : "id";
  await pool.query(
    `UPDATE merge_risk_decision_daily d SET calls=d.calls-1
       FROM ${table} r
      WHERE r.${key}=$1 AND d.day=(r.created_at AT TIME ZONE 'UTC')::date AND d.calls>0`,
    [id]
  );
}
