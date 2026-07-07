import type { Pool } from "pg";

import type { ProviderQuotaProvider, ProviderQuotaSnapshot } from "./types.js";

type ProviderQuotaSnapshotRow = {
  id: number;
  provider: ProviderQuotaProvider;
  account_label: string | null;
  account_id: string | null;
  source: string;
  window_id: string;
  title: string;
  used_percent: string | number | null;
  window_minutes: number | null;
  resets_at: Date | string | null;
  fetched_at: Date | string;
  status: "ok" | "unavailable" | "error";
  error: string | null;
};

export type ProviderQuotaSnapshotResponse = ProviderQuotaSnapshot & {
  id: number;
};

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: ProviderQuotaSnapshotRow): ProviderQuotaSnapshotResponse {
  return {
    id: row.id,
    provider: row.provider,
    accountLabel: row.account_label,
    accountId: row.account_id,
    source: row.source,
    windowId: row.window_id,
    title: row.title,
    usedPercent: toNumber(row.used_percent),
    windowMinutes: row.window_minutes,
    resetsAt: toDate(row.resets_at),
    fetchedAt: toDate(row.fetched_at) ?? new Date(),
    status: row.status,
    error: row.error,
  };
}

export class ProviderQuotaStore {
  constructor(private readonly pool: Pool) {}

  async listLatest(): Promise<ProviderQuotaSnapshotResponse[]> {
    const result = await this.pool.query<ProviderQuotaSnapshotRow>(
      `SELECT id, provider, account_label, account_id, source, window_id, title,
              used_percent, window_minutes, resets_at, fetched_at, status, error
       FROM provider_quota_snapshots
       WHERE NOT (provider = 'claude' AND source = 'anthropic-oauth-file')
       ORDER BY provider, account_label NULLS LAST, account_id NULLS LAST,
                source, window_id`
    );
    return result.rows.map(mapRow);
  }

  async upsertSnapshots(snapshots: ProviderQuotaSnapshot[]): Promise<void> {
    await this.cleanupLegacySourceRows(snapshots);
    for (const snapshot of snapshots) {
      await this.pool.query(
        `INSERT INTO provider_quota_snapshots (
           provider, account_label, account_id, source, window_id, title,
           used_percent, window_minutes, resets_at, fetched_at, status, error
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (
           provider,
           (COALESCE(account_id, '')),
           (COALESCE(account_label, '')),
           window_id,
           source
         )
         DO UPDATE SET
           title = EXCLUDED.title,
           used_percent = EXCLUDED.used_percent,
           window_minutes = EXCLUDED.window_minutes,
           resets_at = EXCLUDED.resets_at,
           fetched_at = EXCLUDED.fetched_at,
           status = EXCLUDED.status,
           error = EXCLUDED.error,
           updated_at = NOW()`,
        [
          snapshot.provider,
          snapshot.accountLabel,
          snapshot.accountId,
          snapshot.source,
          snapshot.windowId,
          snapshot.title,
          snapshot.usedPercent,
          snapshot.windowMinutes,
          snapshot.resetsAt,
          snapshot.fetchedAt,
          snapshot.status,
          snapshot.error,
        ]
      );
    }
  }

  private async cleanupLegacySourceRows(
    snapshots: ProviderQuotaSnapshot[]
  ): Promise<void> {
    if (!snapshots.some((snapshot) => snapshot.provider === "claude")) return;
    const hasClaudeOk = snapshots.some(
      (snapshot) => snapshot.provider === "claude" && snapshot.status === "ok"
    );
    if (hasClaudeOk) {
      await this.pool.query(
        `DELETE FROM provider_quota_snapshots
         WHERE provider = 'claude'
           AND (
             source = 'anthropic-oauth-file'
             OR (source = 'anthropic-oauth' AND status <> 'ok')
           )`
      );
      return;
    }
    await this.pool.query(
      `DELETE FROM provider_quota_snapshots
       WHERE provider = 'claude' AND source = 'anthropic-oauth-file'`
    );
  }
}
