import type { Pool } from "pg";

export const WHITEBOARD_SNAPSHOT_FILENAME = "whiteboard.png";

export const MAX_ELEMENTS = 20_000;

export const EMPTY_SCENE = { elements: [] as unknown[] };

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
