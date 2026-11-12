import type { PoolClient } from "pg";

/**
 * Dispatch enforces no daily, call or token limit on provider requests: spend
 * limits belong to the API key's own provider settings. The only guard is
 * concurrency, so requests are never fired at the same time (at most two in
 * flight across assessments and explanations).
 *
 * Caller owns a transaction and must reserve its pending record before commit.
 */
export async function mergeRiskCapacity(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(719394023)");
  await client.query(
    "UPDATE merge_risk_decision_records SET status='interrupted' WHERE status='pending' AND created_at < now() - interval '2 minutes'"
  );
  await client.query(
    "UPDATE merge_risk_explanations SET status='interrupted' WHERE status='pending' AND created_at < now() - interval '2 minutes'"
  );
  const pending = await client.query(
    "SELECT 1 FROM merge_risk_decision_records WHERE status='pending' UNION ALL SELECT 1 FROM merge_risk_explanations WHERE status='pending' LIMIT 2"
  );
  return pending.rowCount! >= 2 ? "skipped_concurrency" : "pending";
}
