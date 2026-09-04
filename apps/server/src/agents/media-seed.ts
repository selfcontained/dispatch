import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

export type SeedMediaInput = {
  fileName: string;
  originalName?: string;
  buffer: Buffer;
  source: "text" | "user";
  description?: string | null;
};

export type SeededMedia = {
  /** The `media` row id, so callers can reference the file by id. */
  mediaId: number;
  fileName: string;
  displayName: string;
  source: string;
  description: string | null;
};

/**
 * Format `<base>-<iso-timestamp>-<index+1><ext>` for a freshly-seeded
 * media file. The timestamp is sanitized (`:` and `.` → `-`) so the
 * result is safe to use as a filename on every supported platform.
 *
 * Exported for unit tests — small enough that a regression in the
 * timestamp formatting would be hard to spot otherwise.
 */
export function timestampMediaFileName(
  fileName: string,
  createdAt: Date,
  index: number
): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return `${base}-${timestamp}-${index + 1}${ext}`;
}

/**
 * Write each `files[i].buffer` to `<mediaDir>/<timestamped name>` and
 * insert a matching `media` row, returning the metadata the caller
 * passes through to `buildStartupPrompt`.
 *
 * Used only by `createAgent`'s initial-media path, but split out so
 * the manager doesn't have to own the fs+DB write loop directly.
 *
 * Caller is responsible for `mkdir(mediaDir, { recursive: true })`
 * — every callsite has the dir already in place, and re-creating
 * inside this function would duplicate that work.
 */
export async function seedInitialMedia(
  pool: Pool,
  agentId: string,
  mediaDir: string,
  files: SeedMediaInput[]
): Promise<SeededMedia[]> {
  const createdAt = new Date();
  const results: SeededMedia[] = [];

  for (const [index, file] of files.entries()) {
    const timestampedFileName = timestampMediaFileName(
      file.fileName,
      createdAt,
      index
    );
    await writeFile(path.join(mediaDir, timestampedFileName), file.buffer);
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        agentId,
        timestampedFileName,
        file.source,
        file.buffer.length,
        file.description ?? null,
      ]
    );
    results.push({
      mediaId: inserted.rows[0].id,
      fileName: timestampedFileName,
      displayName: file.originalName?.trim() || file.fileName,
      source: file.source,
      description: file.description ?? null,
    });
  }

  return results;
}
