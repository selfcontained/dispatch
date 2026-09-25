import type { FastifyInstance } from "fastify";
import type { AgentRouteDeps } from "./shared.js";

/** User API only: scoped agent MCP tokens cannot answer permission requests. */
export async function registerAgentPermissionRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/permissions", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await deps.agentManager.getAgent(id)))
      return reply.code(404).send({ error: "Agent not found." });
    return deps.agentManager.getPermissions(id);
  });

  app.post(
    "/api/v1/agents/:id/permissions/:requestId",
    async (request, reply) => {
      const { id, requestId } = request.params as {
        id: string;
        requestId: string;
      };
      const body = request.body as { optionId?: unknown } | null;
      if (
        !body ||
        (body.optionId !== null &&
          (typeof body.optionId !== "string" ||
            !body.optionId ||
            body.optionId.length > 1000))
      ) {
        return reply.code(400).send({
          error: "optionId must be an offered choice or null to cancel.",
        });
      }
      try {
        await deps.agentManager.answerPermission(
          id,
          requestId,
          body.optionId as string | null
        );
        return deps.agentManager.getPermissions(id);
      } catch (err) {
        return deps.handleAgentError(reply, err);
      }
    }
  );
}
