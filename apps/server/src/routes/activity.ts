import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import {
  computeActivityStats,
  computeDailyStatus,
  computeWorkingTimeByProject,
  type ActivityEventRow,
} from "../activity-metrics.js";

type ActivityRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  parseActivityQuery: (query: Record<string, unknown>) => {
    start: Date | null;
    end: Date | null;
    tz: string;
    granularity: "hour" | "day" | "week" | "month";
  };
  loadScopedActivityEvents: (
    aq: ReturnType<ActivityRouteDeps["parseActivityQuery"]>
  ) => Promise<{ rows: ActivityEventRow[]; rangeStart: Date | null }>;
  timeRangeClause: (
    aq: ReturnType<ActivityRouteDeps["parseActivityQuery"]>,
    column: string,
    paramOffset?: number
  ) => { clause: string; params: unknown[] };
  dateTruncTz: (
    granularity: "hour" | "day" | "week" | "month",
    column: string,
    tz: string
  ) => string;
  escapeLike: (s: string) => string;
};

export async function registerActivityRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
): Promise<void> {
  app.get("/api/v1/activity/heatmap", async (request) => {
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
  });

  app.get("/api/v1/activity/stats", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
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
  });

  app.get("/api/v1/activity/daily-status", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const { rows, rangeStart } = await deps.loadScopedActivityEvents(aq);
    return {
      days: computeDailyStatus(rows, rangeStart, aq.granularity),
      granularity: aq.granularity,
    };
  });

  app.get("/api/v1/activity/active-hours", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const eventFilter = deps.timeRangeClause(aq, "created_at");
    const result = await deps.pool.query<{ created_at: string }>(
      `SELECT created_at::text AS created_at
       FROM agent_events
       ${eventFilter.clause ? `${eventFilter.clause} AND` : "WHERE"} event_type IN ('working', 'blocked', 'waiting_user')
       ORDER BY created_at`,
      eventFilter.params
    );
    return { events: result.rows };
  });

  app.get("/api/v1/activity/agents-created", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
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
  });

  app.get("/api/v1/activity/working-time-by-project", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const rangeStart = aq.start;
    const eventFilter = deps.timeRangeClause(aq, "ae.created_at");
    const inRangeResult = await deps.pool.query<ActivityEventRow>(
      `SELECT ae.agent_id, ae.event_type, ae.created_at,
              COALESCE(ae.project_dir, a.cwd) AS project_dir
       FROM agent_events ae
       LEFT JOIN agents a ON a.id = ae.agent_id
       ${eventFilter.clause}
       ORDER BY ae.agent_id, ae.created_at`,
      eventFilter.params
    );

    let rows = inRangeResult.rows;
    if (rangeStart) {
      const boundaryResult = await deps.pool.query<ActivityEventRow>(
        `SELECT DISTINCT ON (ae.agent_id) ae.agent_id, ae.event_type, ae.created_at,
                COALESCE(ae.project_dir, a.cwd) AS project_dir
         FROM agent_events ae
         LEFT JOIN agents a ON a.id = ae.agent_id
         WHERE ae.created_at < $1
         ORDER BY ae.agent_id, ae.created_at DESC`,
        [rangeStart]
      );
      rows = [...boundaryResult.rows, ...inRangeResult.rows].sort((a, b) => {
        const agentCompare = a.agent_id.localeCompare(b.agent_id);
        if (agentCompare !== 0) return agentCompare;
        return a.created_at.getTime() - b.created_at.getTime();
      });
    }

    return { projects: computeWorkingTimeByProject(rows, rangeStart) };
  });

  app.get("/api/v1/activity/token-stats", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const tokenFilter = deps.timeRangeClause(
      aq,
      "COALESCE(session_start, harvested_at)"
    );
    const result = await deps.pool.query<{
      total_input: number;
      total_cache_creation: number;
      total_cache_read: number;
      total_output: number;
      total_messages: number;
      total_sessions: number;
    }>(
      `SELECT
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(message_count), 0) AS total_messages,
        COUNT(DISTINCT session_id) AS total_sessions
       FROM agent_token_usage
       ${tokenFilter.clause}`,
      tokenFilter.params
    );
    return (
      result.rows[0] ?? {
        total_input: 0,
        total_cache_creation: 0,
        total_cache_read: 0,
        total_output: 0,
        total_messages: 0,
        total_sessions: 0,
      }
    );
  });

  app.get("/api/v1/activity/token-daily", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const tokenFilter = deps.timeRangeClause(
      aq,
      "COALESCE(session_start, harvested_at)"
    );
    const result = await deps.pool.query<{
      day: string;
      input_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      output_tokens: number;
      messages: number;
    }>(
      `SELECT
        ${deps.dateTruncTz(aq.granularity, "COALESCE(session_start, harvested_at)", aq.tz)} AS day,
        SUM(input_tokens) AS input_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(message_count) AS messages
       FROM agent_token_usage
       ${tokenFilter.clause}
       GROUP BY day ORDER BY day`,
      tokenFilter.params
    );
    return { days: result.rows, granularity: aq.granularity };
  });

  app.get("/api/v1/activity/token-by-project", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const tokenFilter = deps.timeRangeClause(
      aq,
      "COALESCE(t.session_start, t.harvested_at)"
    );
    const result = await deps.pool.query<{
      project_dir: string;
      total_input: number;
      total_output: number;
      messages: number;
    }>(
      `SELECT
        COALESCE(a.git_context->>'repoRoot', a.cwd) AS project_dir,
        SUM(t.input_tokens + t.cache_creation_tokens + t.cache_read_tokens) AS total_input,
        SUM(t.output_tokens) AS total_output,
        SUM(t.message_count) AS messages
       FROM agent_token_usage t
       JOIN agents a ON a.id = t.agent_id
       ${tokenFilter.clause}
       GROUP BY project_dir
       ORDER BY total_input DESC
       LIMIT 20`,
      tokenFilter.params
    );
    return { projects: result.rows };
  });

  app.get("/api/v1/activity/token-by-model", async (request) => {
    const aq = deps.parseActivityQuery(
      request.query as Record<string, unknown>
    );
    const tokenFilter = deps.timeRangeClause(
      aq,
      "COALESCE(session_start, harvested_at)"
    );
    const result = await deps.pool.query<{
      model: string;
      total_input: number;
      total_cache_creation: number;
      total_cache_read: number;
      total_output: number;
      sessions: number;
    }>(
      `SELECT
        model,
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COUNT(DISTINCT session_id) AS sessions
       FROM agent_token_usage
       ${tokenFilter.clause}
       GROUP BY model
       ORDER BY (SUM(input_tokens) + SUM(cache_creation_tokens) + SUM(cache_read_tokens) + SUM(output_tokens)) DESC`,
      tokenFilter.params
    );
    return { models: result.rows };
  });

  app.post("/api/v1/agents/:id/harvest-tokens", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    await deps.agentManager.harvestAgentTokens(agent);
    return { ok: true };
  });

  app.get("/api/v1/history/projects", async () => {
    const result = await deps.pool.query<{ project: string }>(
      `SELECT DISTINCT COALESCE(git_context->>'repoRoot', cwd) AS project
       FROM agents
       WHERE COALESCE(git_context->>'repoRoot', cwd) IS NOT NULL
       ORDER BY project`
    );
    return { projects: result.rows.map((row) => row.project) };
  });

  app.get("/api/v1/history/agents", async (request) => {
    const query = request.query as Record<string, unknown>;
    const aq = deps.parseActivityQuery(query);
    const limit = Math.min(
      Math.max(parseInt(String(query.limit ?? "50"), 10) || 50, 1),
      100
    );
    const offset = Math.max(parseInt(String(query.offset ?? "0"), 10) || 0, 0);
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const type = typeof query.type === "string" ? query.type : "";
    const project = typeof query.project === "string" ? query.project : "";
    const sortCol =
      typeof query.sort === "string" &&
      ["created_at", "name", "updated_at"].includes(query.sort)
        ? query.sort
        : "created_at";
    const order =
      typeof query.order === "string" && query.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = ["a.parent_agent_id IS NULL"];
    const params: unknown[] = [];
    if (search) {
      params.push(`%${deps.escapeLike(search)}%`);
      conditions.push(`a.name ILIKE $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`a.type = $${params.length}`);
    }
    if (project) {
      params.push(project);
      conditions.push(
        `COALESCE(a.git_context->>'repoRoot', a.cwd) = $${params.length}`
      );
    }

    const dateRange = deps.timeRangeClause(aq, "a.created_at", params.length);
    params.push(...dateRange.params);
    if (dateRange.params.length > 0) {
      conditions.push(dateRange.clause.replace(/^WHERE\s+/i, ""));
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortSql =
      sortCol === "name"
        ? `a.name ${order}, a.created_at DESC`
        : `a.${sortCol} ${order}`;
    const listParams = [...params, limit, offset];

    const [countResult, agentsResult] = await Promise.all([
      deps.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM agents a ${whereClause}`,
        params
      ),
      deps.pool.query(
        `SELECT
          a.id,
          a.name,
          a.type,
          a.status,
          a.cwd,
          a.worktree_path AS "worktreePath",
          a.worktree_branch AS "worktreeBranch",
          CASE
            WHEN a.latest_event_type IS NULL OR a.latest_event_message IS NULL OR a.latest_event_updated_at IS NULL THEN NULL
            ELSE json_build_object(
              'type', a.latest_event_type,
              'message', a.latest_event_message,
              'updatedAt', a.latest_event_updated_at,
              'metadata', COALESCE(a.latest_event_metadata, '{}'::jsonb)
            )
          END AS "latestEvent",
          a.git_context AS "gitContext",
          a.created_at AS "createdAt",
          a.updated_at AS "updatedAt",
          EXTRACT(EPOCH FROM (a.updated_at - a.created_at))::int * 1000 AS "durationMs",
          COALESCE((
            SELECT SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens)
            FROM agent_token_usage WHERE agent_id = a.id
          ), 0)::bigint AS "totalTokens"
         FROM agents a
         ${whereClause}
         ORDER BY ${sortSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        listParams
      ),
    ]);

    const parentIds = agentsResult.rows.map(
      (agent: { id: string }) => agent.id
    );
    type ChildAgent = {
      id: string;
      name: string;
      persona: string | null;
      status: string;
      totalTokens: number;
      createdAt: string;
    };
    const childrenByParent = new Map<string, ChildAgent[]>();

    if (parentIds.length > 0) {
      const childResult = await deps.pool.query<
        ChildAgent & { parentAgentId: string }
      >(
        `SELECT
          a.id,
          a.name,
          a.persona,
          a.status,
          COALESCE((
            SELECT SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens)
            FROM agent_token_usage WHERE agent_id = a.id
          ), 0)::bigint AS "totalTokens",
          a.created_at AS "createdAt",
          a.parent_agent_id AS "parentAgentId"
         FROM agents a
         WHERE a.parent_agent_id = ANY($1)
         ORDER BY a.created_at ASC`,
        [parentIds]
      );
      for (const child of childResult.rows) {
        const list = childrenByParent.get(child.parentAgentId) ?? [];
        if (!childrenByParent.has(child.parentAgentId)) {
          childrenByParent.set(child.parentAgentId, list);
        }
        list.push({
          id: child.id,
          name: child.name,
          persona: child.persona,
          status: child.status,
          totalTokens: child.totalTokens,
          createdAt: child.createdAt,
        });
      }
    }

    const agents = agentsResult.rows.map(
      (agent: { id: string; totalTokens: number }) => {
        const children = childrenByParent.get(agent.id) ?? [];
        const childTokens = children.reduce(
          (sum, child) => sum + child.totalTokens,
          0
        );
        return {
          ...agent,
          children,
          groupTotalTokens: agent.totalTokens + childTokens,
        };
      }
    );

    return { agents, total: countResult.rows[0]?.total ?? 0, limit, offset };
  });

  app.get("/api/v1/history/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agentResult = await deps.pool.query(
      `SELECT
        id, name, type, status, cwd,
        worktree_path AS "worktreePath",
        worktree_branch AS "worktreeBranch",
        CASE
          WHEN latest_event_type IS NULL OR latest_event_message IS NULL OR latest_event_updated_at IS NULL THEN NULL
          ELSE json_build_object(
            'type', latest_event_type,
            'message', latest_event_message,
            'updatedAt', latest_event_updated_at,
            'metadata', COALESCE(latest_event_metadata, '{}'::jsonb)
          )
        END AS "latestEvent",
        git_context AS "gitContext",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM agents WHERE id = $1`,
      [id]
    );
    if (agentResult.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found" });
    }

    const [
      eventsResult,
      tokenResult,
      tokenByModelResult,
      mediaResult,
      feedbackResult,
    ] = await Promise.all([
      deps.pool.query<{
        id: number;
        event_type: string;
        message: string;
        metadata: Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT id, event_type, message, metadata, created_at
           FROM agent_events WHERE agent_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      deps.pool.query<{
        total_input: number;
        total_cache_creation: number;
        total_cache_read: number;
        total_output: number;
        total_messages: number;
      }>(
        `SELECT
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
            COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(message_count), 0) AS total_messages
           FROM agent_token_usage WHERE agent_id = $1`,
        [id]
      ),
      deps.pool.query<{
        model: string;
        input_tokens: number;
        output_tokens: number;
      }>(
        `SELECT model,
            SUM(input_tokens + cache_creation_tokens + cache_read_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
           FROM agent_token_usage WHERE agent_id = $1
           GROUP BY model ORDER BY (SUM(input_tokens + cache_creation_tokens + cache_read_tokens) + SUM(output_tokens)) DESC`,
        [id]
      ),
      deps.pool.query<{
        file_name: string;
        source: string;
        size_bytes: number;
        description: string | null;
        created_at: string;
      }>(
        `SELECT file_name, source, size_bytes, description, created_at
           FROM media WHERE agent_id = $1 ORDER BY created_at`,
        [id]
      ),
      deps.pool.query<{
        id: number;
        agentId: string;
        persona: string | null;
        severity: string;
        filePath: string | null;
        lineNumber: number | null;
        description: string;
        suggestion: string | null;
        mediaRef: string | null;
        status: string;
        createdAt: string;
      }>(
        `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath",
                  f.line_number AS "lineNumber", f.description, f.suggestion, f.media_ref AS "mediaRef",
                  f.status, f.created_at AS "createdAt"
           FROM agent_feedback f
           JOIN agents a ON a.id = f.agent_id
           WHERE a.parent_agent_id = $1
           ORDER BY f.created_at ASC
           LIMIT 500`,
        [id]
      ),
    ]);

    const eventRows: ActivityEventRow[] = eventsResult.rows.map((row) => ({
      agent_id: id,
      event_type: row.event_type,
      created_at: new Date(row.created_at),
    }));
    const stats = computeActivityStats(eventRows, null);

    return {
      agent: agentResult.rows[0],
      events: eventsResult.rows,
      tokenUsage: { ...tokenResult.rows[0], by_model: tokenByModelResult.rows },
      media: mediaResult.rows,
      feedback: feedbackResult.rows,
      stateDurations: stats.stateDurations,
    };
  });
}
