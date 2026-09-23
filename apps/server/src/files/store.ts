import type { Pool } from "pg";

export type FileListItem = {
  id: number;
  fileName: string;
  source: string;
  sizeBytes: number;
  updatedAt: string;
  description: string | null;
  /** Read from the file's bytes when it was stored; see `detectFileType`. */
  mimeType: string;
};

export type OwnedFileItem = FileListItem & {
  agentId: string;
};

type FileRow = {
  id: number;
  file_name: string;
  source: string;
  size_bytes: number;
  effective_updated_at: Date;
  description: string | null;
  mime_type: string;
};

const FILE_PROJECTION = `id, file_name, source, size_bytes,
  COALESCE(updated_at, created_at) AS effective_updated_at, description,
  mime_type`;

function mapFileRow(row: FileRow): FileListItem {
  return {
    id: row.id,
    fileName: row.file_name,
    source: row.source,
    sizeBytes: row.size_bytes,
    updatedAt: row.effective_updated_at.toISOString(),
    description: row.description ?? null,
    mimeType: row.mime_type,
  };
}

export async function listFileRows(
  pool: Pool,
  agentId: string
): Promise<FileListItem[]> {
  const result = await pool.query<FileRow>(
    `SELECT ${FILE_PROJECTION}
     FROM files WHERE agent_id = $1
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`,
    [agentId]
  );

  return result.rows.map(mapFileRow);
}

export async function getFileById(
  pool: Pool,
  fileId: number
): Promise<OwnedFileItem | null> {
  const result = await pool.query<FileRow & { agent_id: string }>(
    `SELECT agent_id, ${FILE_PROJECTION}
     FROM files
     WHERE id = $1`,
    [fileId]
  );
  const row = result.rows[0];
  return row ? { ...mapFileRow(row), agentId: row.agent_id } : null;
}

export async function loadSeenFileKeys(
  pool: Pool,
  agentId: string,
  keys: string[]
): Promise<Set<string>> {
  if (keys.length === 0) {
    return new Set();
  }

  const result = await pool.query<{ fileKey: string }>(
    `
    SELECT file_key AS "fileKey"
    FROM files_seen
    WHERE agent_id = $1 AND file_key = ANY($2::text[])
    `,
    [agentId, keys]
  );

  return new Set(result.rows.map((row) => row.fileKey));
}

export async function markSeenFileKeys(
  pool: Pool,
  agentId: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await pool.query(
    `
    INSERT INTO files_seen (agent_id, file_key, seen_at)
    SELECT $1, key, NOW()
    FROM UNNEST($2::text[]) AS key
    ON CONFLICT (agent_id, file_key) DO UPDATE
      SET seen_at = EXCLUDED.seen_at
    `,
    [agentId, keys]
  );
}
