import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  computeActivityStats,
  type ActivityEventRow,
} from "../../activity-metrics.js";
import type { ActivityRouteDeps } from "./shared.js";

async function handleHistoryProjects(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const query = request.query as Record<string, unknown>;
  const search =
    typeof query.search === "string" ? query.search.trim().toLowerCase() : "";
  const limit = Math.min(
    Math.max(parseInt(String(query.limit ?? "20"), 10) || 20, 1),
    50
  );
  const params: unknown[] = [];
  const where = [
    "parent_agent_id IS NULL",
    "COALESCE(git_context->>'repoRoot', cwd) IS NOT NULL",
  ];

  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(LOWER(COALESCE(git_context->>'repoRoot', cwd)) LIKE $${params.length} OR LOWER(regexp_replace(COALESCE(git_context->>'repoRoot', cwd), '/+$', '')) LIKE $${params.length})`
    );
  }
  params.push(limit);

  const result = await deps.pool.query<{
    project: string;
    usage_count: number;
    latest_created_at: Date;
    agent_id: string;
    icon_agent_id: string | null;
  }>(
    `SELECT project,
              COUNT(*)::int AS usage_count,
              MAX(created_at) AS latest_created_at,
              (ARRAY_AGG(id ORDER BY created_at DESC))[1] AS agent_id,
              (ARRAY_AGG(id ORDER BY created_at DESC) FILTER (WHERE repo_icon_path IS NOT NULL))[1] AS icon_agent_id
       FROM (
         SELECT id,
                created_at,
                COALESCE(git_context->>'repoRoot', cwd) AS project,
                git_context->>'repoIconPath' AS repo_icon_path
         FROM agents
         WHERE ${where.join(" AND ")}
       ) project_agents
       GROUP BY project
       ORDER BY usage_count DESC, latest_created_at DESC, project ASC
       LIMIT $${params.length}`,
    params
  );

  const projectOptions = result.rows.map((row) => ({
    path: row.project,
    usageCount: row.usage_count,
    latestCreatedAt: row.latest_created_at.toISOString(),
    iconUrl: row.icon_agent_id
      ? `/api/v1/agents/${encodeURIComponent(row.icon_agent_id)}/repo-icon`
      : undefined,
  }));

  return {
    projects: projectOptions.map((project) => project.path),
    projectOptions,
  };
}

async function handleHistoryAgents(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
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

  const conditions: string[] = [
    "a.parent_agent_id IS NULL",
    "a.deleted_at IS NOT NULL",
  ];
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

  const parentIds = agentsResult.rows.map((agent: { id: string }) => agent.id);
  type ChildAgent = {
    id: string;
    name: string;
    persona: string | null;
    status: string;
    latestEvent: {
      type: string;
      message: string;
      updatedAt: string;
      metadata: Record<string, unknown> | null;
    } | null;
    totalTokens: number;
    createdAt: string;
    updatedAt: string;
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
          CASE
            WHEN a.latest_event_type IS NULL OR a.latest_event_message IS NULL OR a.latest_event_updated_at IS NULL THEN NULL
            ELSE json_build_object(
              'type', a.latest_event_type,
              'message', a.latest_event_message,
              'updatedAt', a.latest_event_updated_at,
              'metadata', COALESCE(a.latest_event_metadata, '{}'::jsonb)
            )
          END AS "latestEvent",
          COALESCE((
            SELECT SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens)
            FROM agent_token_usage WHERE agent_id = a.id
          ), 0)::bigint AS "totalTokens",
          a.created_at AS "createdAt",
          a.updated_at AS "updatedAt",
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
        latestEvent: child.latestEvent,
        totalTokens: child.totalTokens,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
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
}

async function handleHistoryAgentDetail(
  deps: ActivityRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
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
        pins,
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
    messagesResult,
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
      `SELECT f.id, r.reviewer_agent_id AS "agentId",
                  COALESCE(ra.persona, r.reviewer_type) AS persona,
                  'info' AS severity,
                  f.file_path AS "filePath", f.line_start AS "lineNumber",
                  COALESCE(first_message.content->>'body', '') AS description,
                  NULL::text AS suggestion, NULL::text AS "mediaRef",
                  CASE
                    WHEN f.status = 'open' THEN 'open'
                    WHEN f.resolution = 'fixed' THEN 'fixed'
                    WHEN f.resolution = 'dismissed' THEN 'dismissed'
                    ELSE f.status
                  END AS status,
                  f.created_at AS "createdAt"
           FROM review_feedback_items f
           JOIN reviews r ON r.id = f.review_id
           LEFT JOIN agents ra ON ra.id = r.reviewer_agent_id
           LEFT JOIN LATERAL (
             SELECT content
             FROM review_thread_messages
             WHERE feedback_item_id = f.id
             ORDER BY created_at ASC, id ASC
             LIMIT 1
           ) first_message ON TRUE
           WHERE r.agent_id = $1
           ORDER BY f.created_at ASC
           LIMIT 500`,
      [id]
    ),
    deps.pool.query<{
      id: string;
      senderAgentId: string;
      recipientAgentId: string;
      senderName: string;
      recipientName: string;
      content: string;
      delivered: boolean;
      readAt: string | null;
      createdAt: string;
    }>(
      `SELECT id,
                sender_agent_id AS "senderAgentId",
                recipient_agent_id AS "recipientAgentId",
                sender_name AS "senderName",
                recipient_name AS "recipientName",
                content, delivered,
                read_at AS "readAt",
                created_at AS "createdAt"
           FROM (
             SELECT * FROM agent_messages
              WHERE sender_agent_id = $1 OR recipient_agent_id = $1
              ORDER BY created_at DESC
              LIMIT 500
           ) recent
           ORDER BY created_at ASC`,
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
    messages: messagesResult.rows,
    stateDurations: stats.stateDurations,
  };
}

export async function registerActivityHistoryRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
): Promise<void> {
  app.get("/api/v1/history/projects", (req) =>
    handleHistoryProjects(deps, req)
  );
  app.get("/api/v1/history/agents", (req) => handleHistoryAgents(deps, req));
  app.get("/api/v1/history/agents/:id", (req, reply) =>
    handleHistoryAgentDetail(deps, req, reply)
  );
}
