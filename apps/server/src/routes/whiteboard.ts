import path from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { applyOps } from "../shared/whiteboard-builder.js";
import { resolveMediaDir } from "../shared/media.js";
import { getWhiteboard, saveWhiteboard } from "../shared/whiteboard-store.js";
import {
  simplifyElements,
  type WhiteboardOp,
  type WhiteboardScene,
} from "../shared/whiteboard.js";

type WhiteboardRouteDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
};

export async function registerWhiteboardRoutes(
  app: FastifyInstance,
  deps: WhiteboardRouteDeps
): Promise<void> {
  const { pool, mediaRoot, agentManager, publishUiEvent } = deps;

  app.get("/api/v1/agents/:agentId/whiteboard", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const row = await getWhiteboard(pool, agentId);
    const scene: WhiteboardScene = row?.scene ?? { records: [] };
    return reply.send({
      scene,
      version: row?.version ?? 0,
      elements: simplifyElements(scene.records ?? []),
    });
  });

  app.put("/api/v1/agents/:agentId/whiteboard", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as {
      scene?: WhiteboardScene;
      ops?: WhiteboardOp[];
    };

    if (body.scene) {
      const row = await getWhiteboard(pool, agentId);
      const { version } = await saveWhiteboard(
        pool,
        agentId,
        body.scene,
        row?.version ?? null
      );
      publishUiEvent({
        type: "whiteboard.changed",
        agentId,
        source: "user",
      });
      return reply.send({
        version,
        elementCount: (body.scene.records ?? []).length,
      });
    }

    if (body.ops) {
      const row = await getWhiteboard(pool, agentId);
      const currentScene: WhiteboardScene = row?.scene ?? { records: [] };
      const updated = applyOps(currentScene, body.ops);
      const { version } = await saveWhiteboard(
        pool,
        agentId,
        updated,
        row?.version ?? null
      );
      publishUiEvent({
        type: "whiteboard.changed",
        agentId,
        source: "user",
      });
      return reply.send({
        version,
        elementCount: updated.records.length,
      });
    }

    return reply.code(400).send({ error: "scene or ops required" });
  });

  app.post(
    "/api/v1/agents/:agentId/whiteboard/snapshot",
    async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const agent = await agentManager.getAgent(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "No file uploaded" });
      }

      const buffer = await data.toBuffer();
      const mediaDir = resolveMediaDir(agentId, agent.mediaDir, mediaRoot);
      await mkdir(mediaDir, { recursive: true });
      const snapshotPath = path.join(mediaDir, "whiteboard-snapshot.png");
      await writeFile(snapshotPath, buffer);

      return reply.send({ path: snapshotPath, sizeBytes: buffer.length });
    }
  );

  app.delete(
    "/api/v1/agents/:agentId/whiteboard/snapshot",
    async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const agent = await agentManager.getAgent(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const mediaDir = resolveMediaDir(agentId, agent.mediaDir, mediaRoot);
      const snapshotPath = path.join(mediaDir, "whiteboard-snapshot.png");
      try {
        await unlink(snapshotPath);
      } catch {
        // file doesn't exist, that's fine
      }
      return reply.send({ deleted: true });
    }
  );
}
