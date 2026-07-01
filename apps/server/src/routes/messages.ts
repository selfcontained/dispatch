import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { MessageStore } from "../messages/store.js";

type MessagesRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
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
    const messages = await store.listForAgent(id);
    return { messages };
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
