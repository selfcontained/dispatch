import type { FastifyInstance, FastifyReply } from "fastify";
import type { SurfaceService } from "../surfaces/service.js";
import { SurfaceError } from "../surfaces/service.js";

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof SurfaceError)
    return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

export async function registerSurfaceRoutes(
  app: FastifyInstance,
  deps: { surfaces: SurfaceService }
): Promise<void> {
  app.get("/api/v1/agents/:agentId/surfaces", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const exists = await deps.surfaces.list(agentId);
      return { surfaces: exists };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:agentId/surfaces/:surfaceId/interactions",
    async (request, reply) => {
      const { agentId, surfaceId } = request.params as {
        agentId: string;
        surfaceId: string;
      };
      try {
        const result = await deps.surfaces.submitInteraction(
          agentId,
          surfaceId,
          request.body
        );
        return reply.code(result.duplicate ? 200 : 201).send(result);
      } catch (error) {
        return fail(reply, error);
      }
    }
  );
}
