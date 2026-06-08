import type { FastifyInstance } from "fastify";

import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentEventRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.get("/api/v1/events", async (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const stream = reply.raw;
    const unsubscribe = deps.subscribeUiEvents(stream);
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 20_000);

    try {
      const agents = await deps.agentManager.listAgents();
      deps.sendUiSnapshot(stream, agents.map(deps.withStreamFlag));
    } catch (error) {
      deps.appLog.warn({ err: error }, "Failed to load SSE snapshot.");
    }

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/v1/notifications/ack", async (request, reply) => {
    const body = request.body as { notificationId?: unknown };
    if (typeof body?.notificationId !== "string") {
      return reply
        .code(400)
        .send({ error: "notificationId must be a string." });
    }
    const found = deps.ackWebNotification(body.notificationId);
    deps.appLog.debug(
      { notificationId: body.notificationId, found },
      "Web notification ack received"
    );
    return reply.code(204).send();
  });

  app.post("/api/v1/focus", async (request, reply) => {
    const body = request.body as { agentId?: unknown };
    const agentId = body?.agentId;

    if (agentId === null || agentId === undefined) {
      deps.clearFocusedAgents();
      return reply.code(204).send();
    }

    if (typeof agentId !== "string" || !agentId.trim()) {
      return reply
        .code(400)
        .send({ error: "agentId must be a non-empty string or null." });
    }

    deps.setFocusedAgent(agentId.trim());
    return reply.code(204).send();
  });
}
