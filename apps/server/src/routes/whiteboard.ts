import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { resolveMediaDir } from "../shared/media.js";

// Written into the agent's media dir WITHOUT a `media` DB row: the media
// list is DB-backed, so the snapshot stays out of the unseen-badge flow
// while remaining readable by the agent and servable via the media route.
export const WHITEBOARD_SNAPSHOT_FILENAME = "whiteboard.png";

// Fastify's default JSON bodyLimit is 1 MB; real boards blow past it.
const SCENE_BODY_LIMIT = 8 * 1024 * 1024;
const MAX_ELEMENTS = 20_000;

export const EMPTY_SCENE = { elements: [] as unknown[] };

type WhiteboardRouteDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
};

export type WhiteboardRow = {
  scene: { elements: unknown[] };
  version: string;
  updated_by: string;
  updated_at: Date;
};

export async function loadWhiteboard(
  pool: Pool,
  agentId: string
): Promise<WhiteboardRow | null> {
  const result = await pool.query<WhiteboardRow>(
    "SELECT scene, version, updated_by, updated_at FROM whiteboards WHERE agent_id = $1",
    [agentId]
  );
  return result.rows[0] ?? null;
}

export function isValidScene(scene: unknown): scene is { elements: unknown[] } {
  return (
    typeof scene === "object" &&
    scene !== null &&
    Array.isArray((scene as { elements?: unknown }).elements) &&
    (scene as { elements: unknown[] }).elements.length <= MAX_ELEMENTS
  );
}

export async function saveWhiteboard(
  pool: Pool,
  agentId: string,
  scene: { elements: unknown[] },
  baseVersion: number,
  updatedBy: "user" | "agent"
): Promise<{ version: number } | null> {
  const result = await pool.query<{ version: string }>(
    `INSERT INTO whiteboards (agent_id, scene, version, updated_by)
     VALUES ($1, $2::jsonb, 1, $3)
     ON CONFLICT (agent_id) DO UPDATE
       SET scene = EXCLUDED.scene,
           version = whiteboards.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
       WHERE whiteboards.version = $4
     RETURNING version`,
    [agentId, JSON.stringify(scene), updatedBy, baseVersion]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return { version: Number(result.rows[0].version) };
}

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

  // Clearing the board must also clear the snapshot, or whiteboard_get
  // keeps pointing agents at a rendering of the erased drawing.
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
