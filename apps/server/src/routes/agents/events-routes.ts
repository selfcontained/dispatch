import type { FastifyInstance } from "fastify";

import type { AgentRouteDeps } from "./shared.js";

/** A client-generated app session id: one per tab or installed app window. */
function sessionIdOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value)
    ? value
    : null;
}

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
    const unsubscribe = deps.subscribeUiEvents(
      stream,
      sessionIdOf((request.query as { session?: unknown } | undefined)?.session)
    );
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
      // Reconnect must carry a snapshot to reconcile events missed offline.
      // A heartbeat-only connection would otherwise look healthy forever.
      cleanup();
      stream.end();
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

  app.post("/api/v1/presence", async (request, reply) => {
    const body = request.body as {
      sessionId?: unknown;
      visible?: unknown;
      idleMs?: unknown;
      viewingAgentId?: unknown;
      closed?: unknown;
    } | null;
    const sessionId = sessionIdOf(body?.sessionId);
    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is invalid." });
    }
    if (body?.closed === true) {
      deps.reportPresence?.(sessionId, null);
      return reply.code(204).send();
    }
    const { visible, idleMs, viewingAgentId } = body ?? {};
    if (
      typeof visible !== "boolean" ||
      typeof idleMs !== "number" ||
      !Number.isFinite(idleMs) ||
      (viewingAgentId !== null &&
        (typeof viewingAgentId !== "string" || !viewingAgentId.trim()))
    ) {
      return reply.code(400).send({
        error:
          "visible must be a boolean, idleMs a number and viewingAgentId a string or null.",
      });
    }
    deps.reportPresence?.(sessionId, {
      visible,
      idleMs,
      viewingAgentId:
        typeof viewingAgentId === "string" ? viewingAgentId.trim() : null,
    });
    return reply.code(204).send();
  });
}
