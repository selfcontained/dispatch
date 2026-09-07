import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { resolveMediaDir } from "../shared/media.js";
import {
  EMPTY_SCENE,
  isValidScene,
  loadWhiteboard,
  MAX_ELEMENTS,
  saveWhiteboard,
  WHITEBOARD_SNAPSHOT_FILENAME,
} from "../shared/whiteboard-store.js";
import type { PublishUiEvent } from "../server/ui-events.js";

const SCENE_BODY_LIMIT = 8 * 1024 * 1024;

type WhiteboardRouteDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
};

export async function registerWhiteboardRoutes(
  app: FastifyInstance,
  deps: WhiteboardRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/whiteboard", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const row = await loadWhiteboard(deps.pool, id);
    if (!row) {
      return { scene: EMPTY_SCENE, version: 0, updatedAt: null };
    }
    return {
      scene: row.scene,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
  });

  app.put(
    "/api/v1/agents/:id/whiteboard",
    { bodyLimit: SCENE_BODY_LIMIT },
    async (request, reply) => {
      const params = request.params as { id?: string };
      const id = params.id ?? "";
      const agent = await deps.agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }

      const body = request.body as
        | { scene?: unknown; baseVersion?: unknown }
        | undefined;
      if (!isValidScene(body?.scene)) {
        return reply.code(400).send({
          error: `scene must be an object with an elements array (max ${MAX_ELEMENTS}).`,
        });
      }
      const baseVersion =
        typeof body?.baseVersion === "number" &&
        Number.isInteger(body.baseVersion) &&
        body.baseVersion >= 0
          ? body.baseVersion
          : null;
      if (baseVersion === null) {
        return reply
          .code(400)
          .send({ error: "baseVersion must be a non-negative integer." });
      }

      const saved = await saveWhiteboard(
        deps.pool,
        id,
        body.scene,
        baseVersion,
        "user"
      );
      if (!saved) {
        const current = await loadWhiteboard(deps.pool, id);
        return reply.code(409).send({
          error: "Whiteboard was modified by someone else.",
          scene: current?.scene ?? EMPTY_SCENE,
          version: current ? Number(current.version) : 0,
        });
      }

      deps.publishUiEvent({
        type: "whiteboard.changed",
        agentId: id,
        version: saved.version,
        source: "user",
      });
      return { ok: true, version: saved.version };
    }
  );

  app.post("/api/v1/agents/:id/whiteboard/snapshot", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const data = await request.file();
    if (!data || data.mimetype !== "image/png") {
      return reply.code(400).send({ error: "A PNG file field is required." });
    }

    const mediaDir = resolveMediaDir(id, agent.mediaDir, deps.mediaRoot);
    await mkdir(mediaDir, { recursive: true });
    const buffer = await data.toBuffer();
    await writeFile(path.join(mediaDir, WHITEBOARD_SNAPSHOT_FILENAME), buffer);
    return { ok: true, sizeBytes: buffer.length };
  });

  app.delete(
    "/api/v1/agents/:id/whiteboard/snapshot",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const id = params.id ?? "";
      const agent = await deps.agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      const mediaDir = resolveMediaDir(id, agent.mediaDir, deps.mediaRoot);
      await rm(path.join(mediaDir, WHITEBOARD_SNAPSHOT_FILENAME), {
        force: true,
      });
      return { ok: true };
    }
  );
}
