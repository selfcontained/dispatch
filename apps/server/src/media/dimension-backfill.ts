/**
 * One-time sweep that fills `media.width`/`media.height` for rows created
 * before those columns existed.
 *
 * A sweep rather than a probe-on-read: every insert path now records
 * dimensions, so the rows missing them are a fixed, closed set that will never
 * grow. Probing lazily would put filesystem reads on the chat feed's read path
 * forever to serve a population that shrinks to zero, and would re-attempt the
 * rows whose files are unreadable on every single page load. One pass at
 * startup touches each row once and then never runs again.
 *
 * Entirely best-effort. It runs detached from boot, reads only file headers,
 * and a row it cannot measure keeps its nulls — which renders exactly as it
 * did before this feature, in a fixed-height box.
 */

import path from "node:path";

import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";
import { isImageFile, resolveMediaDir } from "../shared/media.js";

import { probeImageFile } from "./image-dimensions.js";

/** Marks the sweep as having run, so a restart does not repeat it. */
const BACKFILL_SETTING_KEY = "media_dimensions_backfilled";

/** Rows per query. Keeps the working set small on a large media library. */
const BATCH_SIZE = 200;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type CandidateRow = {
  id: number;
  file_name: string;
  agent_id: string;
  media_dir: string | null;
};

export type BackfillResult = {
  /** Image rows examined. */
  scanned: number;
  /** Rows that came away with a width and height. */
  measured: number;
};

/**
 * Measure and store dimensions for every image media row that has none.
 *
 * Exported apart from the guarded launcher below so a test — or an operator
 * re-running it by hand — can drive the pass without the settings flag.
 */
export async function backfillMediaDimensions(
  pool: Pool,
  mediaRoot: string
): Promise<BackfillResult> {
  let scanned = 0;
  let measured = 0;
  // Page by id, not by OFFSET: rows keep their nulls when the probe fails, so
  // the candidate set does not shrink uniformly and an offset walk would skip
  // rows or revisit them.
  let afterId = 0;

  for (;;) {
    const result = await pool.query<CandidateRow>(
      `SELECT m.id, m.file_name, m.agent_id, a.media_dir
         FROM media m
         JOIN agents a ON a.id = m.agent_id
        WHERE m.width IS NULL
          AND m.id > $1
        ORDER BY m.id
        LIMIT $2`,
      [afterId, BATCH_SIZE]
    );
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      afterId = row.id;
      if (!isImageFile(row.file_name)) continue;
      scanned += 1;

      const dir = resolveMediaDir(row.agent_id, row.media_dir, mediaRoot);
      const dimensions = await probeImageFile(path.join(dir, row.file_name));
      if (!dimensions) continue;

      await pool.query(
        `UPDATE media SET width = $2, height = $3 WHERE id = $1`,
        [row.id, dimensions.width, dimensions.height]
      );
      measured += 1;
    }
  }

  return { scanned, measured };
}

/**
 * Run the sweep once per database, in the background.
 *
 * Fire-and-forget by design: boot must not wait on filesystem reads, and a
 * failure here costs nothing but a few rows staying in the fallback box. The
 * flag is set only on success, so a crash mid-sweep just means the next start
 * picks up whatever is still null.
 */
export function startMediaDimensionBackfill(
  pool: Pool,
  mediaRoot: string,
  logger: Logger
): void {
  void (async () => {
    try {
      if (await getSetting(pool, BACKFILL_SETTING_KEY)) return;
      const result = await backfillMediaDimensions(pool, mediaRoot);
      await setSetting(pool, BACKFILL_SETTING_KEY, new Date().toISOString());
      if (result.scanned > 0) {
        logger.info(result, "Backfilled image dimensions on existing media");
      }
    } catch (err) {
      logger.warn(
        { err },
        "Media dimension backfill failed; will retry next start"
      );
    }
  })();
}
