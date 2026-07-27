import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  computeActivityStats,
  computeDailyStatus,
  computeWorkingTimeByProject,
} from "../../activity-metrics.js";
import type { ActivityRouteDeps } from "./shared.js";

async function handleHeatmap(deps: ActivityRouteDeps, request: FastifyRequest) {
  const query = request.query as Record<string, unknown>;
  const days = Math.min(
    Math.max(parseInt((query.days as string) ?? "365", 10) || 365, 1),
    730
  );
  const aq = deps.parseActivityQuery(query);

  const result = await deps.pool.query<{ day: string; count: number }>(
    `SELECT ${deps.dateTruncTz("day", "created_at", aq.tz)} AS day, COUNT(*)::int AS count
       FROM agent_events
       WHERE created_at >= NOW() - make_interval(days => $1)
       GROUP BY day ORDER BY day`,
    [days]
  );

  return { days: result.rows };
}

async function handleStats(deps: ActivityRouteDeps, request: FastifyRequest) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
  const { rows, rangeStart } = await deps.loadScopedActivityEvents(aq);
  const eventFilter = deps.timeRangeClause(aq, "created_at");

  const busiestDayResult = await deps.pool.query<{
    day: string;
    count: number;
  }>(
    `SELECT ${deps.dateTruncTz("day", "created_at", aq.tz)} AS day, COUNT(*)::int AS count
       FROM agent_events
       ${eventFilter.clause}
       GROUP BY day ORDER BY count DESC LIMIT 1`,
    eventFilter.params
  );
  const stats = computeActivityStats(rows, rangeStart);

  return {
    totalWorkingMs: stats.totalWorkingMs,
    avgBlockedMs: stats.avgBlockedMs,
    avgWaitingMs: stats.avgWaitingMs,
    busiestDay: busiestDayResult.rows[0]?.day ?? null,
    busiestDayCount: busiestDayResult.rows[0]?.count ?? 0,
    stateDurations: stats.stateDurations,
  };
}

async function handleDailyStatus(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
  const { rows, rangeStart } = await deps.loadScopedActivityEvents(aq);
  return {
    days: computeDailyStatus(rows, rangeStart, aq.granularity),
    granularity: aq.granularity,
  };
}

async function handleActiveHours(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
  const eventFilter = deps.timeRangeClause(aq, "created_at");
  const result = await deps.pool.query<{ created_at: string }>(
    `SELECT created_at::text AS created_at
       FROM agent_events
       ${eventFilter.clause ? `${eventFilter.clause} AND` : "WHERE"} event_type IN ('working', 'blocked', 'waiting_user')
       ORDER BY created_at`,
    eventFilter.params
  );
  return { events: result.rows };
}

async function handleAgentsCreated(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
  const eventFilter = deps.timeRangeClause(aq, "first_seen");
  const result = await deps.pool.query<{ day: string; count: number }>(
    `SELECT ${deps.dateTruncTz(aq.granularity, "first_seen", aq.tz)} AS day, COUNT(*)::int AS count
       FROM (
         SELECT agent_id, MIN(created_at) AS first_seen
         FROM agent_events
         GROUP BY agent_id
       ) per_agent
       ${eventFilter.clause}
       GROUP BY day ORDER BY day`,
    eventFilter.params
  );
  const total = result.rows.reduce((sum, row) => sum + row.count, 0);
  return { days: result.rows, total, granularity: aq.granularity };
}

async function handleWorkingTimeByProject(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
  const { rows, rangeStart } = await deps.loadScopedActivityEvents(aq, {
    includeProjectDir: true,
  });
  return { projects: computeWorkingTimeByProject(rows, rangeStart) };
}

export async function registerActivityMetricsRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
): Promise<void> {
  app.get("/api/v1/activity/heatmap", (req) => handleHeatmap(deps, req));
  app.get("/api/v1/activity/stats", (req) => handleStats(deps, req));
  app.get("/api/v1/activity/daily-status", (req) =>
    handleDailyStatus(deps, req)
  );
  app.get("/api/v1/activity/active-hours", (req) =>
    handleActiveHours(deps, req)
  );
  app.get("/api/v1/activity/agents-created", (req) =>
    handleAgentsCreated(deps, req)
  );
  app.get("/api/v1/activity/working-time-by-project", (req) =>
    handleWorkingTimeByProject(deps, req)
  );
}
