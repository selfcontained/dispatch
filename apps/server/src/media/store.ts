import type { Pool } from "pg";

export type MediaListItem = {
  fileName: string;
  source: string;
  sizeBytes: number;
  updatedAt: string;
  description: string | null;
};

export async function listMediaFiles(
  pool: Pool,
  agentId: string
): Promise<MediaListItem[]> {
  const result = await pool.query<{
    file_name: string;
    source: string;
    size_bytes: number;
    effective_updated_at: Date;
    description: string | null;
  }>(
    `SELECT file_name, source, size_bytes,
            COALESCE(updated_at, created_at) AS effective_updated_at,
            description
     FROM media WHERE agent_id = $1
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`,
    [agentId]
  );

  return result.rows.map((row) => ({
    fileName: row.file_name,
    source: row.source,
    sizeBytes: row.size_bytes,
    updatedAt: row.effective_updated_at.toISOString(),
    description: row.description ?? null,
  }));
}

export async function loadSeenMediaKeys(
  pool: Pool,
  agentId: string,
  keys: string[]
): Promise<Set<string>> {
  if (keys.length === 0) {
    return new Set();
  }

  const result = await pool.query<{ mediaKey: string }>(
    `
    SELECT media_key AS "mediaKey"
    FROM media_seen
    WHERE agent_id = $1 AND media_key = ANY($2::text[])
    `,
    [agentId, keys]
  );

  return new Set(result.rows.map((row) => row.mediaKey));
}

export async function markSeenMediaKeys(
  pool: Pool,
  agentId: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await pool.query(
    `
    INSERT INTO media_seen (agent_id, media_key, seen_at)
    SELECT $1, key, NOW()
    FROM UNNEST($2::text[]) AS key
    ON CONFLICT (agent_id, media_key) DO UPDATE
      SET seen_at = EXCLUDED.seen_at
    `,
    [agentId, keys]
  );
}
