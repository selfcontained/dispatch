import type {
  AgentConfigResponse,
  AgentConfigUpdateRequest,
} from "@dispatch/shared";
import type { FastifyInstance } from "fastify";

import {
  CodexResetError,
  consumeCodexLimitReset,
  createProviderPlansReporter,
} from "../../agents/provider-plans.js";
import {
  loadAgentUsage,
  toAgentConfigOptions,
} from "../../agents/usage-report.js";
import type { AgentRouteDeps } from "./shared.js";

const CONFIG_VALUE_MAX = 200;

/**
 * A live session's settings (model, effort, mode), what an agent has used,
 * and how much of their subscription plans the engines' logins have left.
 */
export async function registerAgentUsageRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  const providerPlans =
    deps.providerPlans ?? createProviderPlansReporter({ log: deps.appLog });

  app.get("/api/v1/agents/:id/config", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found." });
    const options = deps.agentManager.getConfigOptions(id);
    const response: AgentConfigResponse = {
      running: options !== null,
      options: toAgentConfigOptions(options ?? []),
    };
    return response;
  });

  app.put("/api/v1/agents/:id/config", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as Partial<AgentConfigUpdateRequest> | null;
    const configId = typeof body?.configId === "string" ? body.configId : "";
    const value = typeof body?.value === "string" ? body.value : null;
    if (!configId || value === null || value.length > CONFIG_VALUE_MAX) {
      return reply
        .code(400)
        .send({ error: "configId and value are required." });
    }
    try {
      const options = await deps.agentManager.setConfigOption(
        id,
        configId,
        value
      );
      const response: AgentConfigResponse = {
        running: true,
        options: toAgentConfigOptions(options),
      };
      return response;
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.get("/api/v1/agents/:id/usage", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found." });
    return loadAgentUsage(deps.pool, {
      id: agent.id,
      cliSessionId: agent.cliSessionId ?? null,
    });
  });

  app.get("/api/v1/usage/plans", async (request) => {
    const force = (request.query as { force?: string }).force === "1";
    return providerPlans({ force });
  });

  // Spends one of the Codex account's limit resets. Reached only from the
  // popover's confirmed dialog; the cached plans are dropped so the next
  // read shows the windows as ChatGPT now has them.
  app.post("/api/v1/usage/codex/resets/consume", async (request, reply) => {
    const consume =
      deps.consumeCodexReset ??
      (() => consumeCodexLimitReset({ log: deps.appLog }));
    try {
      const outcome = await consume();
      providerPlans.invalidate?.();
      return outcome;
    } catch (error) {
      if (error instanceof CodexResetError) {
        // A request that reached ChatGPT may have been honoured even though
        // its answer was lost: drop the cached plans so the next read tells.
        if (error.reason !== "not_signed_in") providerPlans.invalidate?.();
        return reply
          .code(error.reason === "not_signed_in" ? 409 : 502)
          .send({ error: error.message, reason: error.reason });
      }
      throw error;
    }
  });
}
