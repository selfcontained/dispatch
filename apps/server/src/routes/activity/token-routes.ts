import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ActivityRouteDeps } from "./shared.js";

async function handleTokenStats(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
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
}

async function handleTokenDaily(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
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
}

async function handleTokenByProject(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
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
}

async function handleTokenByModel(
  deps: ActivityRouteDeps,
  request: FastifyRequest
) {
  const aq = deps.parseActivityQuery(request.query as Record<string, unknown>);
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
}

async function handleHarvestTokens(
  deps: ActivityRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { id } = request.params as { id: string };
  const agent = await deps.agentManager.getAgent(id);
  if (!agent) {
    return reply.code(404).send({ error: "Agent not found" });
  }
  await deps.agentManager.harvestAgentTokens(agent);
  return { ok: true };
}

export async function registerActivityTokenRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
): Promise<void> {
  app.get("/api/v1/activity/token-stats", (req) => handleTokenStats(deps, req));
  app.get("/api/v1/activity/token-daily", (req) => handleTokenDaily(deps, req));
  app.get("/api/v1/activity/token-by-project", (req) =>
    handleTokenByProject(deps, req)
  );
  app.get("/api/v1/activity/token-by-model", (req) =>
    handleTokenByModel(deps, req)
  );
  app.post("/api/v1/agents/:id/harvest-tokens", (req, reply) =>
    handleHarvestTokens(deps, req, reply)
  );
}
