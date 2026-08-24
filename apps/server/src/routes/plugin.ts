import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { getEnabledAgentTypes } from "../agent-type-settings.js";
import { CLI_BY_AGENT_TYPE } from "../agents/tmux/command-builder.js";
import type { AppConfig } from "../config.js";
import {
  createPluginStatusChecker,
  isPluginAgentType,
  PLUGIN_AGENT_TYPES,
  type PluginStatusChecker,
} from "../shared/plugin-status.js";

type PluginRouteDeps = {
  pool: Pool;
  config: AppConfig;
  appLog: FastifyBaseLogger;
};

export async function registerPluginRoutes(
  app: FastifyInstance,
  deps: PluginRouteDeps
): Promise<void> {
  const checker: PluginStatusChecker = createPluginStatusChecker({
    binFor: (agentType) => deps.config[CLI_BY_AGENT_TYPE[agentType]],
    logger: deps.appLog,
  });

  app.get("/api/v1/plugin/status", async (request) => {
    const query = request.query as { refresh?: unknown };
    const forceRefresh = query?.refresh === "true" || query?.refresh === "1";

    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    const applicableTypes = PLUGIN_AGENT_TYPES.filter((type) =>
      enabledAgentTypes.includes(type)
    );

    const statuses = await Promise.all(
      applicableTypes.map((agentType) =>
        checker.getStatus(agentType, { forceRefresh })
      )
    );

    return { statuses };
  });

  app.post("/api/v1/plugin/update", async (request, reply) => {
    const body = request.body as { agentType?: unknown } | null;
    if (!isPluginAgentType(body?.agentType)) {
      return reply.code(400).send({
        error: `agentType must be one of: ${PLUGIN_AGENT_TYPES.join(", ")}.`,
      });
    }
    const agentType = body.agentType;

    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    if (!enabledAgentTypes.includes(agentType)) {
      return reply
        .code(400)
        .send({ error: `${agentType} is not an enabled agent type.` });
    }

    const result = await checker.update(agentType);

    if (result.error) {
      // ranCommands are subcommands only (no bin path, no absolute paths) —
      // see plugin-status.ts's step definitions — so this is safe to return
      // as-is; `result.error` is the curated friendly message, not raw
      // stderr (see the runStep/stepFailed split in plugin-status.ts).
      return reply.code(502).send({
        error: result.error,
        ranCommands: result.ranCommands,
        status: result.status,
      });
    }

    return { status: result.status };
  });
}
