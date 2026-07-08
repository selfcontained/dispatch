import type { Pool } from "pg";

import type { ProviderQuotaProvider, ProviderQuotaSnapshot } from "./types.js";
import type { ActivityQuery } from "../server/activity-query.js";

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

export type ProviderQuotaObservationTrigger = "background" | "manual" | "seed";

type ProviderQuotaObservationRow = {
  provider: ProviderQuotaProvider;
  window_id: string;
  title: string;
  kind: string;
  scope: string;
  window_seconds: number | null;
  day: string;
  avg_used_percent: string | number | null;
  max_used_percent: string | number | null;
  observations: number;
};

type ProviderQuotaCompletedWindowRow = {
  provider: ProviderQuotaProvider;
  window_id: string;
  title: string;
  kind: string;
  scope: string;
  resets_at: Date | string;
  used_percent: string | number | null;
  unused_percent: string | number | null;
};

export type ProviderQuotaHistoryPoint = {
  day: string;
  avgUsedPercent: number | null;
  maxUsedPercent: number | null;
  observations: number;
};

export type ProviderQuotaHistorySeries = {
  provider: ProviderQuotaProvider;
  windowId: string;
  title: string;
  kind: string;
  scope: string;
  windowSeconds: number | null;
  points: ProviderQuotaHistoryPoint[];
};

export type ProviderQuotaCompletedWindow = {
  provider: ProviderQuotaProvider;
  windowId: string;
  title: string;
  kind: string;
  scope: string;
  resetsAt: Date;
  usedPercent: number | null;
  unusedPercent: number | null;
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

function quotaKind(windowId: string, title: string): string {
  const id = windowId.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  if (id.startsWith("credits")) return "credits";
  if (
    id.includes("weekly") ||
    id.includes("seven_day") ||
    id.includes("secondary_window") ||
    normalizedTitle.includes("weekly")
  ) {
    return "weekly";
  }
  if (
    id.includes("session") ||
    id.includes("five_hour") ||
    id.includes("primary_window")
  ) {
    return "session";
  }
  return id.includes(":") ? "bucket" : "window";
}

function quotaScope(windowId: string, title: string): string {
  const id = windowId.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  if (id.startsWith("credits")) return "credits";
  if (
    id.includes("model") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("fable") ||
    id.includes("gpt") ||
    normalizedTitle.includes("sonnet") ||
    normalizedTitle.includes("opus") ||
    normalizedTitle.includes("fable") ||
    normalizedTitle.includes("gpt")
  ) {
    return "model";
  }
  return "account";
}

function mapHistoryRows(
  rows: ProviderQuotaObservationRow[]
): ProviderQuotaHistorySeries[] {
  const series = new Map<string, ProviderQuotaHistorySeries>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.window_id}`;
    let entry = series.get(key);
    if (!entry) {
      entry = {
        provider: row.provider,
        windowId: row.window_id,
        title: row.title,
        kind: row.kind,
        scope: row.scope,
        windowSeconds: row.window_seconds,
        points: [],
      };
      series.set(key, entry);
    }
    entry.points.push({
      day: row.day,
      avgUsedPercent: toNumber(row.avg_used_percent),
      maxUsedPercent: toNumber(row.max_used_percent),
      observations: row.observations,
    });
  }
  return Array.from(series.values());
}

function mapCompletedWindow(
  row: ProviderQuotaCompletedWindowRow
): ProviderQuotaCompletedWindow {
  return {
    provider: row.provider,
    windowId: row.window_id,
    title: row.title,
    kind: row.kind,
    scope: row.scope,
    resetsAt: toDate(row.resets_at) ?? new Date(),
    usedPercent: toNumber(row.used_percent),
    unusedPercent: toNumber(row.unused_percent),
  };
}

export class ProviderQuotaStore {
  constructor(private readonly pool: Pool) {}

  async listLatest(): Promise<ProviderQuotaSnapshotResponse[]> {
    const result = await this.pool.query<ProviderQuotaSnapshotRow>(
      `WITH source_sets AS (
         SELECT provider, account_label, account_id, source,
                COUNT(*)::int AS snapshots,
                MAX(fetched_at) AS newest_fetched_at
         FROM provider_quota_snapshots
         WHERE NOT (provider = 'claude' AND source = 'anthropic-oauth-file')
         GROUP BY provider, account_label, account_id, source
       ),
       selected_sources AS (
         SELECT DISTINCT ON (provider)
                provider, account_label, account_id, source
         FROM source_sets
         ORDER BY provider,
                  CASE WHEN source <> 'seed-demo' THEN 0 ELSE 1 END,
                  newest_fetched_at DESC,
                  snapshots DESC
       )
       SELECT s.id, s.provider, s.account_label, s.account_id, s.source,
              s.window_id, s.title, s.used_percent, s.window_minutes,
              s.resets_at, s.fetched_at, s.status, s.error
       FROM provider_quota_snapshots s
       JOIN selected_sources ss
         ON ss.provider = s.provider
        AND ss.source = s.source
        AND COALESCE(ss.account_id, '') = COALESCE(s.account_id, '')
        AND COALESCE(ss.account_label, '') = COALESCE(s.account_label, '')
       WHERE NOT (s.provider = 'claude' AND s.source = 'anthropic-oauth-file')
       ORDER BY provider, account_label NULLS LAST, account_id NULLS LAST,
                source, window_id`
    );
    return result.rows.map(mapRow);
  }

  async upsertSnapshots(
    snapshots: ProviderQuotaSnapshot[],
    trigger: ProviderQuotaObservationTrigger = "background"
  ): Promise<void> {
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
      await this.insertObservation(snapshot, trigger);
    }
  }

  async listHistory(
    aq: ActivityQuery,
    dateTruncTz: (
      granularity: ActivityQuery["granularity"],
      column: string,
      tz: string
    ) => string
  ): Promise<ProviderQuotaHistorySeries[]> {
    const filter = this.observationRangeClause(aq, "observed_at");
    const selectedFilter = this.observationRangeClause(
      aq,
      "o.observed_at",
      filter.params.length
    );
    const result = await this.pool.query<ProviderQuotaObservationRow>(
      `WITH source_sets AS (
         SELECT provider, account_label, account_id, source,
                COUNT(*)::int AS observations,
                COUNT(DISTINCT ${dateTruncTz("day", "observed_at", aq.tz)})::int AS days
         FROM provider_quota_observations
         ${filter.clause}
         GROUP BY provider, account_label, account_id, source
       ),
       selected_sources AS (
         SELECT DISTINCT ON (provider)
                provider, account_label, account_id, source
         FROM source_sets
         ORDER BY provider,
                  CASE
                    WHEN source <> 'seed-demo' AND observations >= 6 AND days >= 2 THEN 0
                    WHEN source = 'seed-demo' THEN 1
                    ELSE 2
                  END,
                  observations DESC,
                  days DESC
       ),
       selected_observations AS (
         SELECT o.*
         FROM provider_quota_observations o
         JOIN selected_sources ss
           ON ss.provider = o.provider
          AND ss.source = o.source
          AND COALESCE(ss.account_id, '') = COALESCE(o.account_id, '')
          AND COALESCE(ss.account_label, '') = COALESCE(o.account_label, '')
         ${selectedFilter.clause ? `${selectedFilter.clause} AND` : "WHERE"}
           TRUE
       )
       SELECT provider, window_id, title, kind, scope, window_seconds,
              ${dateTruncTz(aq.granularity, "observed_at", aq.tz)} AS day,
              ROUND(AVG(used_percent), 2) AS avg_used_percent,
              MAX(used_percent) AS max_used_percent,
              COUNT(*)::int AS observations
       FROM selected_observations
       WHERE status = 'ok' AND used_percent IS NOT NULL
       GROUP BY provider, window_id, title, kind, scope, window_seconds, day
       ORDER BY provider, kind, scope, window_id, day`,
      [...filter.params, ...selectedFilter.params]
    );
    return mapHistoryRows(result.rows);
  }

  async listCompletedWindows(
    aq: ActivityQuery
  ): Promise<ProviderQuotaCompletedWindow[]> {
    const filter = this.observationRangeClause(aq, "resets_at");
    const selectedFilter = this.observationRangeClause(
      aq,
      "o.resets_at",
      filter.params.length
    );
    const result = await this.pool.query<ProviderQuotaCompletedWindowRow>(
      `WITH source_sets AS (
         SELECT provider, account_label, account_id, source,
                COUNT(*)::int AS observations,
                COUNT(DISTINCT resets_at::date)::int AS days
         FROM provider_quota_observations
         ${filter.clause}
         GROUP BY provider, account_label, account_id, source
       ),
       selected_sources AS (
         SELECT DISTINCT ON (provider)
                provider, account_label, account_id, source
         FROM source_sets
         ORDER BY provider,
                  CASE
                    WHEN source <> 'seed-demo' AND observations >= 6 AND days >= 2 THEN 0
                    WHEN source = 'seed-demo' THEN 1
                    ELSE 2
                  END,
                  observations DESC,
                  days DESC
       ),
       selected_observations AS (
         SELECT o.*
         FROM provider_quota_observations o
         JOIN selected_sources ss
           ON ss.provider = o.provider
          AND ss.source = o.source
          AND COALESCE(ss.account_id, '') = COALESCE(o.account_id, '')
          AND COALESCE(ss.account_label, '') = COALESCE(o.account_label, '')
         ${selectedFilter.clause ? `${selectedFilter.clause} AND` : "WHERE"}
           TRUE
       ),
       ranked AS (
         SELECT provider, window_id, title, kind, scope, resets_at,
                used_percent,
                GREATEST(0, 100 - COALESCE(used_percent, 0)) AS unused_percent,
                ROW_NUMBER() OVER (
                  PARTITION BY provider, account_id, account_label, source,
                               window_id, resets_at
                  ORDER BY observed_at DESC
                ) AS rn
         FROM selected_observations
         WHERE status = 'ok' AND scope = 'account'
           AND resets_at IS NOT NULL
           AND resets_at <= NOW()
           AND observed_at <= resets_at
       )
       SELECT provider, window_id, title, kind, scope, resets_at,
              used_percent, unused_percent
       FROM ranked
       WHERE rn = 1
       ORDER BY resets_at DESC, provider, window_id
       LIMIT 500`,
      [...filter.params, ...selectedFilter.params]
    );
    return result.rows.map(mapCompletedWindow);
  }

  private async insertObservation(
    snapshot: ProviderQuotaSnapshot,
    trigger: ProviderQuotaObservationTrigger
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_quota_observations (
         provider, account_label, account_id, source, window_id, title,
         kind, scope, observed_at, used_percent, resets_at, window_seconds,
         status, trigger, error
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        snapshot.provider,
        snapshot.accountLabel,
        snapshot.accountId,
        snapshot.source,
        snapshot.windowId,
        snapshot.title,
        quotaKind(snapshot.windowId, snapshot.title),
        quotaScope(snapshot.windowId, snapshot.title),
        snapshot.fetchedAt,
        snapshot.usedPercent,
        snapshot.resetsAt,
        snapshot.windowMinutes === null ? null : snapshot.windowMinutes * 60,
        snapshot.status,
        trigger,
        snapshot.error,
      ]
    );
  }

  private observationRangeClause(
    aq: ActivityQuery,
    column: string,
    paramOffset = 0
  ): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (aq.start) {
      params.push(aq.start);
      conditions.push(`${column} >= $${paramOffset + params.length}`);
    }
    if (aq.end) {
      params.push(aq.end);
      conditions.push(`${column} <= $${paramOffset + params.length}`);
    }
    return {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
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
