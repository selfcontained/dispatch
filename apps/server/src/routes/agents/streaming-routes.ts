import type { FastifyInstance } from "fastify";

import { errorMessage } from "../../shared/lib/error-message.js";
import { escapeHtml, type AgentRouteDeps } from "./shared.js";

export async function registerAgentStreamingRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.post("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as {
      type?: unknown;
      port?: unknown;
      description?: unknown;
    };
    if (body?.type === "stop") {
      const description =
        typeof body.description === "string" ? body.description : null;
      deps.stopStream(id, description);
      return { ok: true };
    }

    if (body?.type === "playwright") {
      if (
        typeof body.port !== "number" ||
        !Number.isFinite(body.port) ||
        body.port < 1
      ) {
        return reply
          .code(400)
          .send({ error: "port must be a positive number." });
      }
      if (deps.hasStream(id)) {
        return reply
          .code(409)
          .send({ error: "Stream already active for this agent." });
      }
      try {
        await deps.startStream(id, body.port);
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
      return { ok: true };
    }

    return reply
      .code(400)
      .send({ error: "type must be 'playwright' or 'stop'." });
  });

  app.get("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (!deps.hasStream(id)) {
      return reply
        .code(404)
        .send({ error: "No active stream for this agent." });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders();
    if (raw.socket) {
      raw.socket.setNoDelay(true);
    }

    const unsubscribe = deps.addStreamViewer(id, raw);
    reply.raw.on("close", () => {
      unsubscribe();
    });
  });

  app.get("/api/v1/agents/:id/stream/viewer", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(agent.name)} — Live Stream</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
  img{max-width:100%;max-height:100%;object-fit:contain}
  .gone{display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:system-ui;font-size:14px}
</style>
</head><body>
<img id="feed" src="/api/v1/agents/${escapeHtml(id)}/stream" alt="Live stream">
<script>
  const img = document.getElementById('feed');
  img.onerror = () => {
    document.body.innerHTML = '<div class="gone">Stream ended.</div>';
  };
</script>
</body></html>`;
    return reply.type("text/html").send(html);
  });
}
