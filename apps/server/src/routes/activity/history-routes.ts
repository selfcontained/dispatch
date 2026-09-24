import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { fileMedia } from "@dispatch/shared";
import type {
  HistoryChildAgent,
  HistoryFile,
  HistoryTokenByModel,
  HistoryTokenTotals,
} from "./history-wire.js";
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
    "COALESCE(launch_cwd, git_context->>'repoRoot', cwd) IS NOT NULL",
  ];

  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(LOWER(COALESCE(launch_cwd, git_context->>'repoRoot', cwd)) LIKE $${params.length} OR LOWER(regexp_replace(COALESCE(launch_cwd, git_context->>'repoRoot', cwd), '/+$', '')) LIKE $${params.length})`
    );
  }
  params.push(limit);

  const result = await deps.pool.query<{
    project: string;
    usage_count: number;
    latest_created_at: Date;
    agent_id: string;
  }>(
    `SELECT project,
              COUNT(*)::int AS usage_count,
              MAX(created_at) AS latest_created_at,
              (ARRAY_AGG(id ORDER BY created_at DESC))[1] AS agent_id
       FROM (
         SELECT id,
                created_at,
                COALESCE(launch_cwd, git_context->>'repoRoot', cwd) AS project
         FROM agents
         WHERE ${where.join(" AND ")}
       ) project_agents
       GROUP BY project
       ORDER BY usage_count DESC, latest_created_at DESC, project ASC
       LIMIT $${params.length}`,
    params
  );

  // The picker loads icons as images, independently of the history response.
  // Keep this search endpoint responsive even when a project has a large tree.
  const projectOptions = result.rows.map((row) => ({
    path: row.project,
    usageCount: row.usage_count,
    latestCreatedAt: row.latest_created_at.toISOString(),
    iconUrl: `/api/v1/agents/${encodeURIComponent(row.agent_id)}/repo-icon`,
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
      `COALESCE(a.launch_cwd, a.git_context->>'repoRoot', a.cwd) = $${params.length}`
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
  const childrenByParent = new Map<string, HistoryChildAgent[]>();

  if (parentIds.length > 0) {
    const childResult = await deps.pool.query<
      HistoryChildAgent & { parentAgentId: string }
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
        git_context AS "gitContext",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM agents WHERE id = $1`,
    [id]
  );
  if (agentResult.rows.length === 0) {
    return reply.code(404).send({ error: "Agent not found" });
  }

  const [tokenResult, tokenByModelResult, filesResult] = await Promise.all([
    deps.pool.query<HistoryTokenTotals>(
      `SELECT
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
            COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(message_count), 0) AS total_messages
           FROM agent_token_usage WHERE agent_id = $1`,
      [id]
    ),
    deps.pool.query<HistoryTokenByModel>(
      `SELECT model,
            SUM(input_tokens + cache_creation_tokens + cache_read_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
           FROM agent_token_usage WHERE agent_id = $1
           GROUP BY model ORDER BY (SUM(input_tokens + cache_creation_tokens + cache_read_tokens) + SUM(output_tokens)) DESC`,
      [id]
    ),
    deps.pool.query<Omit<HistoryFile, "media">>(
      `SELECT id, file_name, source, size_bytes, description, created_at,
              mime_type
           FROM files WHERE agent_id = $1 ORDER BY created_at`,
      [id]
    ),
  ]);

  return {
    agent: agentResult.rows[0],
    tokenUsage: { ...tokenResult.rows[0], by_model: tokenByModelResult.rows },
    files: filesResult.rows.map((file) => ({
      ...file,
      media: fileMedia(file.mime_type),
    })),
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
