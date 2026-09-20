import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { fileMetadataFromBuffer } from "../files/metadata.js";

export type SeedFileInput = {
  fileName: string;
  originalName?: string;
  buffer: Buffer;
  source: "text" | "user";
  description?: string | null;
};

export type SeededFile = {
  /** The `files` row id, so callers can reference the file by id. */
  fileId: number;
  fileName: string;
  displayName: string;
  source: string;
  description: string | null;
};

/**
 * Format `<base>-<iso-timestamp>-<index+1><ext>` for a freshly-seeded
 * file. The timestamp is sanitized (`:` and `.` → `-`) so the
 * result is safe to use as a filename on every supported platform.
 *
 * Exported for unit tests — small enough that a regression in the
 * timestamp formatting would be hard to spot otherwise.
 */
export function timestampFileName(
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
 * Write each `files[i].buffer` to `<filesDir>/<timestamped name>` and
 * insert a matching `files` row, returning the metadata the caller
 * passes through to `buildStartupPrompt`.
 *
 * Used only by `createAgent`'s initial-files path, but split out so
 * the manager doesn't have to own the fs+DB write loop directly.
 *
 * Caller is responsible for `mkdir(filesDir, { recursive: true })`
 * — every callsite has the dir already in place, and re-creating
 * inside this function would duplicate that work.
 */
export async function seedInitialFiles(
  pool: Pool,
  agentId: string,
  filesDir: string,
  files: SeedFileInput[]
): Promise<SeededFile[]> {
  const createdAt = new Date();
  const results: SeededFile[] = [];

  for (const [index, file] of files.entries()) {
    const timestampedFileName = timestampFileName(
      file.fileName,
      createdAt,
      index
    );
    await writeFile(path.join(filesDir, timestampedFileName), file.buffer);
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, description,
                          metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        agentId,
        timestampedFileName,
        file.source,
        file.buffer.length,
        file.description ?? null,
        fileMetadataFromBuffer(file.buffer),
      ]
    );
    results.push({
      fileId: inserted.rows[0].id,
      fileName: timestampedFileName,
      displayName: file.originalName?.trim() || file.fileName,
      source: file.source,
      description: file.description ?? null,
    });
  }

  return results;
}
