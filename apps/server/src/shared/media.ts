import path from "node:path";

import type { Pool } from "pg";

export function sanitizeUploadedFileName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const baseName = path.basename(name, ext).normalize("NFKD");
  const collapsed = baseName
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._() -]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${collapsed || "file"}${ext}`;
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".diff",
  ".patch",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".swift",
  ".kt",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".lua",
  ".zig",
  ".nim",
  ".r",
  ".m",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
]);

export function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

const DOCUMENT_EXTENSIONS = new Set([".pdf"]);

export function isDocumentFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext);
}

export function isMediaFile(name: string): boolean {
  return (
    /\.(png|jpg|jpeg|gif|webp|mp4)$/i.test(name) ||
    isTextFile(name) ||
    isDocumentFile(name)
  );
}

export function mimeType(name: string): string {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.mp4$/i.test(name)) return "video/mp4";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.xml$/i.test(name)) return "application/xml";
  if (/\.html$/i.test(name)) return "text/html";
  if (/\.css$/i.test(name)) return "text/css";
  if (/\.(js|jsx|mjs)$/i.test(name)) return "text/javascript";
  if (/\.csv$/i.test(name)) return "text/csv";
  if (/\.md$/i.test(name)) return "text/markdown";
  if (/\.ya?ml$/i.test(name)) return "text/yaml";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (isTextFile(name)) return "text/plain";
  return "application/octet-stream";
}

export function resolveMediaDir(
  agentId: string,
  mediaDir: string | null,
  mediaRoot: string
): string {
  return mediaDir ?? path.join(mediaRoot, agentId);
}

export async function listMediaFiles(
  pool: Pool,
  agentId: string
): Promise<
  Array<{
    name: string;
    source: string;
    size: number;
    updatedAt: string;
    url: string;
    description: string | null;
  }>
> {
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
    name: row.file_name,
    source: row.source,
    size: row.size_bytes,
    updatedAt: row.effective_updated_at.toISOString(),
    url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(row.file_name)}`,
    description: row.description ?? null,
  }));
}

export function toMediaKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

export function isValidMediaKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }
  return !/[\u0000-\u001F]/.test(key);
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
