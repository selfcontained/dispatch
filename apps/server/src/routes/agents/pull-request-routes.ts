import type { FastifyInstance } from "fastify";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentPullRequestRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id/pull-requests",
    async (request, reply) => {
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      return { pullRequests: deps.pullRequests?.get(request.params.id) ?? [] };
    }
  );
}
