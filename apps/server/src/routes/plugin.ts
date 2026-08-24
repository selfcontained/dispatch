import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { getEnabledAgentTypes } from "../agent-type-settings.js";
import type { AppConfig } from "../config.js";
import {
  applyPluginUpdate,
  checkPluginStatus,
  isPluginCliAgentType,
  PLUGIN_CLI_AGENT_TYPES,
  type PluginCliAgentType,
  type PluginStatus,
} from "../shared/plugin-status.js";

type PluginRouteDeps = {
  pool: Pool;
  config: AppConfig;
};

// A status check refreshes the marketplace clone (a git fetch) on every
// call, so it's cached to keep repeat page loads/polls cheap. Update always
// bypasses the cache — the caller needs a fresh answer, not yesterday's.
const CACHE_TTL_MS = 60 * 60 * 1000;
const statusCache = new Map<
  PluginCliAgentType,
  { status: PluginStatus; checkedAt: number }
>();

function binFor(config: AppConfig, agentType: PluginCliAgentType): string {
  return agentType === "claude" ? config.claudeBin : config.codexBin;
}

async function getStatus(
  config: AppConfig,
  agentType: PluginCliAgentType,
  forceRefresh: boolean
): Promise<PluginStatus> {
  const cached = statusCache.get(agentType);
  if (!forceRefresh && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.status;
  }
  const status = await checkPluginStatus(agentType, binFor(config, agentType));
  statusCache.set(agentType, { status, checkedAt: Date.now() });
  return status;
}

export async function registerPluginRoutes(
  app: FastifyInstance,
  deps: PluginRouteDeps
): Promise<void> {
  app.get("/api/v1/plugin/status", async (request) => {
    const query = request.query as { refresh?: unknown };
    const forceRefresh = query?.refresh === "true" || query?.refresh === "1";

    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    const applicableTypes = PLUGIN_CLI_AGENT_TYPES.filter((type) =>
      enabledAgentTypes.includes(type)
    );

    const statuses = await Promise.all(
      applicableTypes.map((agentType) =>
        getStatus(deps.config, agentType, forceRefresh)
      )
    );

    return { statuses };
  });

  app.post("/api/v1/plugin/update", async (request, reply) => {
    const body = request.body as { agentType?: unknown } | null;
    if (!isPluginCliAgentType(body?.agentType)) {
      return reply.code(400).send({
        error: `agentType must be one of: ${PLUGIN_CLI_AGENT_TYPES.join(", ")}.`,
      });
    }
    const agentType = body.agentType;

    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    if (!enabledAgentTypes.includes(agentType)) {
      return reply
        .code(400)
        .send({ error: `${agentType} is not an enabled agent type.` });
    }

    const result = await applyPluginUpdate(
      agentType,
      binFor(deps.config, agentType)
    );
    statusCache.set(agentType, {
      status: result.status,
      checkedAt: Date.now(),
    });

    if (result.error) {
      return reply.code(502).send({
        error: result.error,
        ranCommands: result.ranCommands,
        status: result.status,
      });
    }

    return { status: result.status };
  });
}
