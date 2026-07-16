import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";
import {
  computeReleaseInfo,
  type ComputeReleaseInfoDeps,
  type ReleaseInfoSnapshot,
} from "./release-info.js";
import { pruneCacheExcept } from "./release-tarball-cache.js";
import type { SubsystemTracker } from "./observability/subsystem-tracker.js";

export const AUTOMATIC_UPDATE_MODE_KEY = "automatic_update_mode";
export const AUTOMATIC_UPDATE_MODES = ["off", "check"] as const;
export type AutomaticUpdateMode = (typeof AUTOMATIC_UPDATE_MODES)[number];

const DEFAULT_MODE: AutomaticUpdateMode = "check";
const STARTUP_DELAY_MS = 45_000;
const RECURRING_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Read the automatic-update mode, treating "unset" as the default and
 * persisting that default on first read so the operator UI can render the
 * stored value without ambiguity. Spec rule: existing installs default to
 * "check" the first time the setting is read or updated.
 */
export async function readAutomaticUpdateMode(
  pool: Pool
): Promise<AutomaticUpdateMode> {
  const raw = await getSetting(pool, AUTOMATIC_UPDATE_MODE_KEY);
  if (raw === null || raw === undefined) {
    await setSetting(pool, AUTOMATIC_UPDATE_MODE_KEY, DEFAULT_MODE);
    return DEFAULT_MODE;
  }
  return isValidMode(raw) ? raw : DEFAULT_MODE;
}

export async function writeAutomaticUpdateMode(
  pool: Pool,
  mode: AutomaticUpdateMode
): Promise<void> {
  await setSetting(pool, AUTOMATIC_UPDATE_MODE_KEY, mode);
}

export function isValidMode(value: unknown): value is AutomaticUpdateMode {
  return (
    typeof value === "string" &&
    (AUTOMATIC_UPDATE_MODES as readonly string[]).includes(value)
  );
}

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export type AutoCheckBroadcaster = (
  snapshot: ReleaseInfoSnapshot | null
) => void;

export type AutoCheckRuntimeDeps = {
  pool: Pool;
  computeDeps: ComputeReleaseInfoDeps;
  /** Returns true when an apply job is in flight; the timer skips checks
   *  during apply so the UI doesn't flap between "available / installing". */
  isApplyInProgress: () => boolean;
  /** Called whenever the cached snapshot changes, including transitions
   *  to null (cleared on apply). The broker handles SSE fanout; this
   *  module just emits on every mutation so all clients stay in sync.
   *  Per-tag toast suppression is the client's job (sonner id + the
   *  dismissed-by-tag localStorage atom). */
  broadcast: AutoCheckBroadcaster;
  logger: Logger;
  tracker?: SubsystemTracker;
};

export type AutoCheckRuntime = ReturnType<typeof createAutoCheckRuntime>;

/**
 * Encapsulates the auto-check scheduler, in-memory snapshot, and the
 * broadcast policy. Constructed once per server process. Tests inject their
 * own deps and drive `runAutoCheckOnce` directly.
 */
export function createAutoCheckRuntime(deps: AutoCheckRuntimeDeps) {
  let snapshot: ReleaseInfoSnapshot | null = null;
  let inflight: Promise<RunResult> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let recurringTimer: ReturnType<typeof setInterval> | null = null;

  type RunResult =
    | { ok: true; snapshot: ReleaseInfoSnapshot }
    | { ok: false; reason: string }
    | { ok: "skipped"; reason: string };

  function getSnapshot(): ReleaseInfoSnapshot | null {
    return snapshot;
  }

  function emitBroadcast(): void {
    try {
      deps.broadcast(snapshot);
    } catch (err) {
      deps.logger.warn({ err }, "auto-update: broadcast hook threw");
    }
  }

  function setSnapshotForWriteThrough(next: ReleaseInfoSnapshot): void {
    snapshot = next;
    // Broadcast on every mutation so all connected clients (including
    // tabs other than the one that triggered the manual check) stay in
    // sync with the server cache. Per-tag toast suppression is handled
    // client-side via sonner toast id + dismissedReleaseToastAtomFamily.
    emitBroadcast();
  }

  /**
   * Drop the snapshot if it advertises an update for `tag`. Called when an
   * apply job for that tag starts so the UI doesn't keep showing
   * "v0.18.42 available" while v0.18.42 is in flight. A snapshot for a
   * different (newer) tag is left intact — that update is still meaningful.
   */
  function clearSnapshotIfMatchesTag(tag: string | null): void {
    if (!tag || !snapshot) return;
    if (snapshot.latestTag === tag) {
      snapshot = null;
      emitBroadcast();
    }
  }

  function runAutoCheckOnce(reason: string): Promise<RunResult> {
    if (inflight) {
      return inflight;
    }
    // Inflight is set synchronously below so a second caller arriving
    // before the first await observes the in-flight state and coalesces
    // onto the same promise.
    const promise = (async (): Promise<RunResult> => {
      const trackedRun = deps.tracker?.start();
      if (deps.isApplyInProgress()) {
        trackedRun?.succeed({ skipped: 1 });
        return { ok: "skipped", reason: "apply in progress" };
      }
      const mode = await readAutomaticUpdateMode(deps.pool).catch(
        () => DEFAULT_MODE
      );
      if (mode === "off") {
        deps.tracker?.setDisabled(true);
        trackedRun?.succeed({ skipped: 1 });
        return { ok: "skipped", reason: "mode=off" };
      }
      deps.tracker?.setDisabled(false);

      deps.logger.info({ reason }, "auto-update: running release check");
      const result = await computeReleaseInfo(deps.computeDeps, {
        logger: deps.logger,
      });
      if (!result.ok) {
        trackedRun?.fail(new Error(result.error));
        deps.logger.warn(
          { error: result.error },
          "auto-update: release check failed; keeping previous snapshot"
        );
        return { ok: false, reason: result.error };
      }
      trackedRun?.succeed({
        updateAvailable: result.snapshot.updateAvailable ? 1 : 0,
      });
      snapshot = result.snapshot;
      emitBroadcast();

      // Prune the local release-tarball cache to the tags we still
      // need: the install's current tag, plus the latest discovered
      // tag (the one a future apply would target). Without this,
      // long-lived installs that keep checking but never upgrade
      // accumulate one tarball per newly shipped release indefinitely.
      // Skip if an apply started during the compute window — its own
      // post-deploy prune will run with the right keep-set.
      if (!deps.isApplyInProgress()) {
        const tagsToKeep = [
          result.snapshot.currentTag,
          result.snapshot.latestTag,
        ].filter((t): t is string => t !== null);
        if (tagsToKeep.length > 0) {
          await pruneCacheExcept(tagsToKeep).catch((err) => {
            deps.logger.warn({ err }, "auto-update: cache prune failed");
          });
        }
      }

      return { ok: true, snapshot: result.snapshot };
    })();
    inflight = promise;
    void promise.finally(() => {
      if (inflight === promise) {
        inflight = null;
      }
    });
    return promise;
  }

  function startScheduler(): void {
    if (startupTimer || recurringTimer) return;
    startupTimer = setTimeout(() => {
      void runAutoCheckOnce("startup");
    }, STARTUP_DELAY_MS);
    startupTimer.unref?.();

    recurringTimer = setInterval(() => {
      void runAutoCheckOnce("interval");
    }, RECURRING_INTERVAL_MS);
    recurringTimer.unref?.();
  }

  function stopScheduler(): void {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (recurringTimer) {
      clearInterval(recurringTimer);
      recurringTimer = null;
    }
  }

  return {
    getSnapshot,
    setSnapshotForWriteThrough,
    clearSnapshotIfMatchesTag,
    runAutoCheckOnce,
    startScheduler,
    stopScheduler,
  };
}
