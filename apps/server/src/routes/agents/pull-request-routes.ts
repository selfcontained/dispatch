import type { FastifyInstance } from "fastify";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentPullRequestRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
) {
  app.post<{
    Params: { id: string };
    Body: { url: string; assessmentId: string };
  }>(
    "/api/v1/agents/:id/pull-requests/explain",
    {
      schema: {
        body: {
          type: "object",
          required: ["url", "assessmentId"],
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri", maxLength: 4096 },
            assessmentId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      // This paid action is browser-only, never an agent bearer-token capability.
      if (request.headers.authorization)
        return reply
          .code(403)
          .send({ error: "Use the browser to explain an assessment." });
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      if (!deps.riskExplanations)
        return reply.code(503).send({ error: "Explanation unavailable." });
      return deps.riskExplanations.explain({
        agentId: request.params.id,
        ...request.body,
      });
    }
  );
  // Explicit authored previews only; never infer a preview from a generic URL.
  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id/preview",
    async (request, reply) => {
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      const { rows } = await deps.pool.query<{
        attachments: import("@dispatch/shared").Block["attachments"];
      }>(
        `SELECT attachments FROM blocks
         WHERE author_agent_id = $1 AND attachments @> '[{"type":"preview"}]'::jsonb
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [request.params.id]
      );
      const preview = rows[0]?.attachments
        .slice()
        .reverse()
        .find((attachment) => attachment.type === "preview");
      return { preview: preview ?? null };
    }
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id/pull-requests",
    async (request, reply) => {
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      return { pullRequests: deps.pullRequests?.get(request.params.id) ?? [] };
    }
  );
  app.post<{ Params: { id: string }; Body: { url: string } }>(
    "/api/v1/agents/:id/pull-requests/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri", maxLength: 4096 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      if (!deps.pullRequests)
        return reply.code(503).send({ error: "PR tracking unavailable." });
      try {
        return {
          pullRequests: await deps.pullRequests.refreshOne(
            request.params.id,
            request.body.url
          ),
        };
      } catch (error) {
        return reply.code(409).send({
          error:
            error instanceof Error
              ? error.message
              : "Could not refresh PR. Please try again.",
        });
      }
    }
  );
  app.post<{ Params: { id: string }; Body: { url: string } }>(
    "/api/v1/agents/:id/pull-requests/dismiss",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri", maxLength: 4096 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!(await deps.agentManager.getAgent(request.params.id)))
        return reply.code(404).send({ error: "Agent not found." });
      if (!deps.pullRequests)
        return reply.code(503).send({ error: "PR tracking unavailable." });
      await deps.pullRequests.dismiss(request.params.id, request.body.url);
      return { pullRequests: deps.pullRequests.get(request.params.id) };
    }
  );
}
