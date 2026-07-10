import type { Pool } from "pg";

import type { WhiteboardScene } from "./whiteboard.js";

export type WhiteboardRow = {
  agent_id: string;
  scene: WhiteboardScene;
  version: number;
};

const OPTIMISTIC_LOCK_MAX_RETRIES = 3;

export async function getWhiteboard(
  pool: Pool,
  agentId: string
): Promise<WhiteboardRow | null> {
  const result = await pool.query<WhiteboardRow>(
    `SELECT agent_id, scene, version FROM whiteboards WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows[0] ?? null;
}

export async function saveWhiteboard(
  pool: Pool,
  agentId: string,
  scene: WhiteboardScene,
  expectedVersion: number | null
): Promise<{ version: number }> {
  for (let attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
    const currentVersion =
      expectedVersion ?? (await getCurrentVersion(pool, agentId));

    if (currentVersion === null) {
      const result = await pool.query<{ version: number }>(
        `INSERT INTO whiteboards (agent_id, scene, version)
         VALUES ($1, $2, 1)
         ON CONFLICT (agent_id) DO UPDATE
           SET scene = $2, version = whiteboards.version + 1, updated_at = NOW()
           WHERE whiteboards.version = 0
         RETURNING version`,
        [agentId, JSON.stringify(scene)]
      );
      if (result.rows.length > 0) {
        return { version: result.rows[0].version };
      }
      const inserted = await pool.query<{ version: number }>(
        `SELECT version FROM whiteboards WHERE agent_id = $1`,
        [agentId]
      );
      if (inserted.rows[0]?.version === 1) {
        return { version: 1 };
      }
      continue;
    }

    const result = await pool.query<{ version: number }>(
      `UPDATE whiteboards
       SET scene = $1, version = version + 1, updated_at = NOW()
       WHERE agent_id = $2 AND version = $3
       RETURNING version`,
      [JSON.stringify(scene), agentId, currentVersion]
    );
    if (result.rows.length > 0) {
      return { version: result.rows[0].version };
    }
  }
  throw new Error("Optimistic lock conflict after retries");
}

async function getCurrentVersion(
  pool: Pool,
  agentId: string
): Promise<number | null> {
  const result = await pool.query<{ version: number }>(
    `SELECT version FROM whiteboards WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows[0]?.version ?? null;
}
