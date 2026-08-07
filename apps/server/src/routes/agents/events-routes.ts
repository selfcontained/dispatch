import type { FastifyInstance } from "fastify";

import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentEventRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.get("/api/v1/events", async (request, reply) => {
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
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      request.raw.removeListener("close", cleanup);
      request.raw.removeListener("aborted", cleanup);
    };

    // Bun does not emit close on ServerResponse, but does emit it on the
    // request. Register before the async snapshot load so early disconnects
    // cannot retain the subscription or heartbeat.
    request.raw.once("close", cleanup);
    request.raw.once("aborted", cleanup);

    if (request.raw.destroyed) {
      cleanup();
      return;
    }

    try {
      const agents = await deps.agentManager.listAgents();
      if (!request.raw.destroyed) {
        deps.sendUiSnapshot(stream, agents.map(deps.withStreamFlag));
      } else {
        cleanup();
      }
    } catch (error) {
      deps.appLog.warn({ err: error }, "Failed to load SSE snapshot.");
    }
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
