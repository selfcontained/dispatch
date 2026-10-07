import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";
import type { ScheduledMessageService } from "../scheduled-messages/service.js";
import { scheduleMessageSchema } from "../scheduled-messages/validation.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { errorMessage } from "../shared/lib/error-message.js";
export async function registerScheduledMessageRoutes(
  app: FastifyInstance,
  service: ScheduledMessageService
) {
  const params = z.object({
    agentId: z.string().min(1),
    id: z.uuid().optional(),
  });
  app.get(
    "/api/v1/agents/:agentId/scheduled-messages",
    async (request, reply) => {
      const p = parseInput(params, request.params, reply);
      if (!p) return;
      return service.list(p.agentId);
    }
  );
  app.post(
    "/api/v1/agents/:agentId/scheduled-messages",
    async (request, reply) => {
      const p = parseInput(params, request.params, reply);
      const input = parseInput(scheduleMessageSchema, request.body, reply);
      if (!p || !input) return;
      try {
        return await service.create(p.agentId, input);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    }
  );
  app.post(
    "/api/v1/agents/:agentId/scheduled-messages/:id",
    async (request, reply) => {
      const p = parseInput(params, request.params, reply);
      const input = parseInput(
        z.object({
          action: z.enum(["pause", "resume", "cancel"]),
          completed: z.boolean().optional(),
        }),
        request.body,
        reply
      );
      if (!p?.id || !input) return;
      try {
        return await service.change(
          p.agentId,
          p.id,
          input.action,
          input.completed
        );
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    }
  );
}
