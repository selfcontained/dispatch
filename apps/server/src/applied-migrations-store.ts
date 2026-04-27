import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/**
 * Local source of truth for which install-update migrations (CRU-146) have
 * been applied on this install. Lives outside the repo checkout so reinstalls
 * and tarball deploys don't clobber it. One entry per migration id, recorded
 * after validation passes for the run that applied it.
 */

// Resolved per call so tests can rebind the env var between runs without
// reloading the module. Production hosts only set the env var at boot, so
// the lookup cost is negligible.
function appliedStorePath(): string {
  return (
    process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH ??
    path.join(os.homedir(), ".dispatch", "applied-migrations.json")
  );
}

export type AppliedMigrationRecord = {
  appliedAt: string;
  /** The release tag the migration was applied during. */
  targetTag: string;
};

export type AppliedMigrationsState = {
  appliedMigrations: Record<string, AppliedMigrationRecord>;
};

const EMPTY_STATE: AppliedMigrationsState = { appliedMigrations: {} };

export async function readAppliedMigrationsState(): Promise<AppliedMigrationsState> {
  try {
    const raw = await readFile(appliedStorePath(), "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return EMPTY_STATE;
    }
    if (!isAppliedState(parsed)) return EMPTY_STATE;
    return parsed;
  } catch {
    return EMPTY_STATE;
  }
}

export async function writeAppliedMigrationsState(
  state: AppliedMigrationsState
): Promise<void> {
  const filePath = appliedStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, filePath);
}

/**
 * Record that one or more migration IDs were applied during the deploy of
 * `targetTag`. No-op for IDs that are already recorded — the operation is
 * idempotent so a re-run of validation after a partial failure can safely
 * mark the rest. Atomic via tmp-file + rename in writeAppliedMigrationsState.
 */
export async function markMigrationsApplied(
  ids: ReadonlyArray<string>,
  targetTag: string,
  now: () => Date = () => new Date()
): Promise<AppliedMigrationsState> {
  if (ids.length === 0) return readAppliedMigrationsState();
  const state = await readAppliedMigrationsState();
  const next: AppliedMigrationsState = {
    appliedMigrations: { ...state.appliedMigrations },
  };
  const stamp = now().toISOString();
  for (const id of ids) {
    if (!next.appliedMigrations[id]) {
      next.appliedMigrations[id] = { appliedAt: stamp, targetTag };
    }
  }
  await writeAppliedMigrationsState(next);
  return next;
}

export function appliedIdSet(state: AppliedMigrationsState): Set<string> {
  return new Set(Object.keys(state.appliedMigrations));
}

function isAppliedState(value: unknown): value is AppliedMigrationsState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!obj.appliedMigrations || typeof obj.appliedMigrations !== "object") {
    return false;
  }
  for (const [, rec] of Object.entries(
    obj.appliedMigrations as Record<string, unknown>
  )) {
    if (!rec || typeof rec !== "object") return false;
    const r = rec as Record<string, unknown>;
    if (typeof r.appliedAt !== "string") return false;
    if (typeof r.targetTag !== "string") return false;
  }
  return true;
}

export { appliedStorePath as APPLIED_MIGRATIONS_STORE_PATH_FN };
