import { randomBytes } from "node:crypto";
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
  // Per-call unique temp filename so two writers can't blow each other's
  // tmp file away. rename() is atomic, so the last writer wins on the
  // final path — that's fine for the apply-state semantics, since the
  // markMigrationsApplied serialization below ensures any two writes
  // agree on the union of ids.
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, filePath);
}

// Per-process serialization of read-modify-write cycles in
// `markMigrationsApplied`. Without this, two overlapping callers can each
// read the pre-write state, build their own next state, and the loser's
// rename clobbers the winner's ids. Chaining each call through a single
// promise makes the cycle effectively transactional within this process.
// Cross-process serialization isn't a concern: the dispatch service runs
// as a single process per install.
let markChain: Promise<AppliedMigrationsState> = Promise.resolve(EMPTY_STATE);

/**
 * Record that one or more migration IDs were applied during the deploy of
 * `targetTag`. No-op for IDs that are already recorded — the operation is
 * idempotent so a re-run of validation after a partial failure can safely
 * mark the rest. Concurrent calls are serialized so two read/modify/write
 * cycles cannot drop each other's IDs.
 */
export async function markMigrationsApplied(
  ids: ReadonlyArray<string>,
  targetTag: string,
  now: () => Date = () => new Date()
): Promise<AppliedMigrationsState> {
  const next = markChain.then(async () => {
    if (ids.length === 0) return readAppliedMigrationsState();
    const state = await readAppliedMigrationsState();
    const merged: AppliedMigrationsState = {
      appliedMigrations: { ...state.appliedMigrations },
    };
    const stamp = now().toISOString();
    for (const id of ids) {
      if (!merged.appliedMigrations[id]) {
        merged.appliedMigrations[id] = { appliedAt: stamp, targetTag };
      }
    }
    await writeAppliedMigrationsState(merged);
    return merged;
  });
  // Swallow errors so a failed write doesn't poison the chain for every
  // future caller. The current call still rejects with the original error.
  markChain = next.catch(() => readAppliedMigrationsState());
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
