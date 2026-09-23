import { rm } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { getSetting } from "../db/settings.js";
import { resolveFilesDir } from "../shared/files.js";

/**
 * How long an archived agent's record and history stay around. Archiving
 * soft-deletes the row so the stream, status history and files remain
 * readable for a while; past this window they are just disk space. `0`
 * keeps archived agents forever.
 */
export const ARCHIVED_AGENT_RETENTION_SETTING = "archived_agent_retention_days";
export const DEFAULT_ARCHIVED_AGENT_RETENTION_DAYS = 30;
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Rows deleted per sweep, so a long-neglected install drains gradually. */
const SWEEP_BATCH = 100;

export type RetentionDeps = {
  pool: Pool;
  logger: FastifyBaseLogger;
  filesRoot: string;
};

export async function readArchivedAgentRetentionDays(
  pool: Pool
): Promise<number> {
  const raw = await getSetting(pool, ARCHIVED_AGENT_RETENTION_SETTING);
  if (raw === null) return DEFAULT_ARCHIVED_AGENT_RETENTION_DAYS;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0
    ? days
    : DEFAULT_ARCHIVED_AGENT_RETENTION_DAYS;
}

/**
 * Hard-delete agents archived longer ago than the retention window: the
 * row (stream events, token usage and file rows cascade from it), the
 * status history and browser feedback that name it, the stream it rooted,
 * and its files directory. A child's posts live in its root's stream and
 * go when the root does. Returns the ids removed.
 */
export async function purgeExpiredArchivedAgents(
  deps: RetentionDeps
): Promise<string[]> {
  const days = await readArchivedAgentRetentionDays(deps.pool);
  if (days <= 0) return [];

  const expired = await deps.pool.query<{
    id: string;
    files_dir: string | null;
  }>(
    `SELECT id, files_dir
       FROM agents
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - ($1::int * interval '1 day')
      ORDER BY deleted_at
      LIMIT $2`,
    [days, SWEEP_BATCH]
  );
  if (expired.rows.length === 0) return [];
  const ids = expired.rows.map((row) => row.id);

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM blocks WHERE stream_id = ANY($1::text[])`, [
      ids,
    ]);
    await client.query(
      `DELETE FROM block_reactions WHERE stream_id = ANY($1::text[])`,
      [ids]
    );
    await client.query(
      `DELETE FROM browser_feedback_submissions WHERE agent_id = ANY($1::text[])`,
      [ids]
    );
    await client.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const row of expired.rows) {
    const dir = resolveFilesDir(row.id, row.files_dir, deps.filesRoot);
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      deps.logger.warn(
        { err, agentId: row.id, dir },
        "Retention: files directory not removed"
      );
    });
  }
  deps.logger.info(
    { count: ids.length, days },
    "Retention: removed expired archived agents"
  );
  return ids;
}

/** Run the sweep now and then hourly; returns a stop function. */
export function startRetentionSweep(deps: RetentionDeps): () => void {
  const run = () =>
    purgeExpiredArchivedAgents(deps).catch((err: unknown) => {
      deps.logger.warn({ err }, "Retention sweep failed");
    });
  void run();
  const timer = setInterval(run, RETENTION_SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
