import type { FastifyInstance } from "fastify";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentPullRequestRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
) {
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
