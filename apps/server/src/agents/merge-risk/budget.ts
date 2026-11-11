import type { PoolClient } from "pg";
/** Caller owns a transaction and must reserve its pending record before commit. */
export async function mergeRiskCapacity(
  client: PoolClient,
  env: NodeJS.ProcessEnv
) {
  const raw = Number(env.DISPATCH_MERGE_RISK_DAILY_CAP ?? 25);
  const cap = Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : 0;
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
