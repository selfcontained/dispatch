import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { getEnabledAgentTypes } from "../agent-type-settings.js";
import {
  isPluginAgentType,
  PLUGIN_AGENT_TYPES,
  type PluginStatusChecker,
} from "../shared/plugin-status.js";

type PluginRouteDeps = {
  pool: Pool;
  plugins: PluginStatusChecker;
};

export async function registerPluginRoutes(
  app: FastifyInstance,
  deps: PluginRouteDeps
): Promise<void> {
  app.get("/api/v1/plugin/status", async (request) => {
    const query = request.query as { refresh?: unknown };
    const forceRefresh = query?.refresh === "true" || query?.refresh === "1";

    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    const applicableTypes = PLUGIN_AGENT_TYPES.filter((type) =>
      enabledAgentTypes.includes(type)
    );

    const statuses = await Promise.all(
      applicableTypes.map((agentType) =>
        deps.plugins.getStatus(agentType, { forceRefresh })
      )
    );

    return { statuses };
  });

  for (const action of ["update", "install"] as const) {
    app.post(`/api/v1/plugin/${action}`, async (request, reply) => {
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

      const result = await deps.plugins[action](agentType);

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
}
