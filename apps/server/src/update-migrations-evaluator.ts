import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureCachedTarball,
  readMigrationsFromTarball,
} from "./release-tarball-cache.js";
import {
  appliedIdSet,
  readAppliedMigrationsState,
} from "./applied-migrations-store.js";
import {
  filterPending,
  loadUpdateMigrations,
  parseManifest,
  type UpdateMigrationFile,
  type UpdateMigrationLoadError,
  type UpdateMigrationManifest,
} from "./update-migrations.js";

/**
 * Evaluator that turns a target release tag into the ordered list of
 * migrations the local install still needs to apply. Wraps the tarball
 * cache + manifest loader + applied-state store so the rest of the server
 * code only knows about "pending migrations for tag X" (CRU-146).
 *
 * Result memoized in-process by tag so a flurry of `release/info` polls
 * doesn't re-extract the tarball N times. Tags are immutable on GitHub so
 * a stale entry never causes correctness issues — the only invalidation
 * point is "we just marked migrations applied", which clears the cache.
 */

export type PendingMigrationsResult = {
  /** Ordered list of pending migration files for the target tag. */
  pending: UpdateMigrationFile[];
  /** Every migration manifest present at the target tag (including applied). */
  all: UpdateMigrationFile[];
  /** Manifest IDs already recorded as applied locally. */
  appliedIds: Set<string>;
  /** Per-file load/parse errors. Surfacing these at the API boundary lets
   *  the operator see what's broken without requiring server logs. */
  errors: UpdateMigrationLoadError[];
};

export type EvaluatorContext = {
  /** GitHub repo slug ("owner/repo") used to fetch the tarball. */
  repo: string;
  /** Optional progress hook — same shape as the cache's onProgress. */
  onProgress?: (info: {
    message: string;
    bytesReceived?: number;
    totalBytes?: number | null;
  }) => void;
};

const cache = new Map<string, PendingMigrationsResult>();

/**
 * Evaluate pending migrations for a target tag. Downloads + caches the
 * release tarball if it isn't already present.
 */
export async function evaluatePendingMigrations(
  tag: string,
  ctx: EvaluatorContext
): Promise<PendingMigrationsResult> {
  const memo = cache.get(tag);
  if (memo) return memo;

  const cached = await ensureCachedTarball({
    tag,
    repo: ctx.repo,
    onProgress: ctx.onProgress,
  });

  const files = await readMigrationsFromTarball(cached.path);

  // Reuse the on-disk loader for parsing+ordering by writing the in-memory
  // contents to a temp dir. Keeps a single source of truth for filename
  // pattern matching and ordering rules; the perf cost is one mkdir +
  // small file writes per uncached tag.
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "dispatch-migration-eval-")
  );
  try {
    for (const f of files) {
      await writeFile(path.join(tmpDir, f.filename), f.contents, "utf-8");
    }
    const loaded = await loadUpdateMigrations(tmpDir);
    const state = await readAppliedMigrationsState();
    const ids = appliedIdSet(state);
    const result: PendingMigrationsResult = {
      all: loaded.migrations,
      pending: filterPending(loaded.migrations, ids),
      appliedIds: ids,
      errors: loaded.errors,
    };
    cache.set(tag, result);
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Evaluate pending migrations from raw manifest contents (no tarball).
 * Used by tests and any callers that already have manifest YAML in hand.
 */
export function evaluateFromManifests(
  files: ReadonlyArray<{ filename: string; contents: string }>,
  appliedIds: ReadonlySet<string>
): PendingMigrationsResult {
  const MANIFEST_FILE_RE = /^(\d+)-([a-z0-9][a-z0-9-]*)\.ya?ml$/i;
  const matched = files
    .map((f) => {
      const m = MANIFEST_FILE_RE.exec(f.filename);
      if (!m) return null;
      return {
        filename: f.filename,
        order: Number(m[1]),
        contents: f.contents,
      };
    })
    .filter(
      (x): x is { filename: string; order: number; contents: string } =>
        x !== null
    )
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.filename.localeCompare(b.filename);
    });

  const all: UpdateMigrationFile[] = [];
  const errors: UpdateMigrationLoadError[] = [];
  const seen = new Map<string, string>();
  for (const { filename, order, contents } of matched) {
    const parsed = parseManifest(contents);
    if (!parsed.success) {
      errors.push({ filename, error: parsed.error });
      continue;
    }
    const prior = seen.get(parsed.data.id);
    if (prior) {
      errors.push({
        filename,
        error: `duplicate migration id "${parsed.data.id}" (also defined in ${prior})`,
      });
      continue;
    }
    seen.set(parsed.data.id, filename);
    all.push({ filename, order, manifest: parsed.data });
  }

  return {
    all,
    pending: filterPending(all, appliedIds),
    appliedIds: new Set(appliedIds),
    errors,
  };
}

/**
 * Drop memoized results — call this after marking migrations applied so the
 * next `release/info` poll picks up the new state.
 */
export function clearEvaluatorCache(): void {
  cache.clear();
}

export type PendingMigrationSummary = {
  id: string;
  title: string;
  summary: string;
};

export function toSummary(
  manifest: UpdateMigrationManifest
): PendingMigrationSummary {
  return {
    id: manifest.id,
    title: manifest.title,
    summary: manifest.summary,
  };
}
