import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { MessageStore } from "../messages/store.js";
import type { PublishUiEvent } from "../server/ui-events.js";

type MessagesRouteDeps = {
  pool: Pool;
  publishUiEvent: PublishUiEvent;
};

export async function registerMessagesRoutes(
  app: FastifyInstance,
  deps: MessagesRouteDeps
): Promise<void> {
  const store = new MessageStore(deps.pool);

  app.get("/api/v1/agents/:id/messages", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const exists = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    // unreadCount is computed server-side (uses the partial unread index) so
    // the badge stays accurate even though listForAgent is capped.
    const [messages, unreadCount] = await Promise.all([
      store.listForAgent(id),
      store.countUnreadForAgent(id),
    ]);
    return { messages, unreadCount };
  });

  app.post("/api/v1/agents/:id/messages/read", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const exists = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const updated = await store.markReadForAgent(id);
    if (updated > 0) {
      deps.publishUiEvent({ type: "message.read", agentId: id });
    }
    return { ok: true, updated };
  });
}
