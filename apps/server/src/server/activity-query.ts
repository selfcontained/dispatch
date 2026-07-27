import type { Pool } from "pg";

import type { ActivityEventRow } from "../activity-metrics.js";

export type ActivityGranularity = "hour" | "day" | "week" | "month";

export type ActivityQuery = {
  start: Date | null;
  end: Date | null;
  tz: string;
  granularity: ActivityGranularity;
};

const VALID_GRANULARITIES = new Set<ActivityGranularity>([
  "hour",
  "day",
  "week",
  "month",
]);
const FALLBACK_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));
VALID_TIMEZONES.add("UTC");

export function parseActivityQuery(
  query: Record<string, unknown>
): ActivityQuery {
  const startStr = typeof query.start === "string" ? query.start : "";
  const endStr = typeof query.end === "string" ? query.end : "";
  const rawTz =
    typeof query.tz === "string" && query.tz ? query.tz : FALLBACK_TZ;
  const tz = VALID_TIMEZONES.has(rawTz) ? rawTz : FALLBACK_TZ;
  const gran =
    typeof query.granularity === "string" ? query.granularity : "day";

  const start = startStr ? new Date(startStr) : null;
  const end = endStr ? new Date(endStr) : null;

  return {
    start: start && !Number.isNaN(start.getTime()) ? start : null,
    end: end && !Number.isNaN(end.getTime()) ? end : null,
    tz,
    granularity: VALID_GRANULARITIES.has(gran as ActivityGranularity)
      ? (gran as ActivityGranularity)
      : "day",
  };
}

export function timeRangeClause(
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

export function dateTruncTz(
  granularity: ActivityGranularity,
  column: string,
  tz: string
): string {
  const escaped = tz.replace(/'/g, "''");
  const trunc = `date_trunc('${granularity}', ${column} AT TIME ZONE '${escaped}')`;
  if (granularity === "hour") {
    return `to_char(${trunc}, 'YYYY-MM-DD HH24:00')`;
  }
  return `${trunc}::date::text`;
}

export async function loadScopedActivityEvents(
  pool: Pool,
  aq: ActivityQuery,
  opts: { includeProjectDir?: boolean } = {}
): Promise<{ rows: ActivityEventRow[]; rangeStart: Date | null }> {
  const rangeStart = aq.start;
  const alias = opts.includeProjectDir ? "ae." : "";
  const columns = opts.includeProjectDir
    ? `ae.agent_id, ae.event_type, ae.created_at,
       COALESCE(ae.project_dir, a.cwd) AS project_dir`
    : "agent_id, event_type, created_at";
  const from = opts.includeProjectDir
    ? `FROM agent_events ae
       LEFT JOIN agents a ON a.id = ae.agent_id`
    : "FROM agent_events";
  const eventFilter = timeRangeClause(aq, `${alias}created_at`);

  const inRangeResult = await pool.query<ActivityEventRow>(
    `SELECT ${columns}
     ${from}
     ${eventFilter.clause}
     ORDER BY ${alias}agent_id, ${alias}created_at`,
    eventFilter.params
  );

  if (!rangeStart) {
    return { rows: inRangeResult.rows, rangeStart: null };
  }

  const boundaryResult = await pool.query<ActivityEventRow>(
    `SELECT DISTINCT ON (${alias}agent_id) ${columns}
     ${from}
     WHERE ${alias}created_at < $1
     ORDER BY ${alias}agent_id, ${alias}created_at DESC`,
    [rangeStart]
  );

  const rows = [...boundaryResult.rows, ...inRangeResult.rows].sort((a, b) => {
    const agentCompare = a.agent_id.localeCompare(b.agent_id);
    if (agentCompare !== 0) return agentCompare;
    return a.created_at.getTime() - b.created_at.getTime();
  });

  return { rows, rangeStart };
}
