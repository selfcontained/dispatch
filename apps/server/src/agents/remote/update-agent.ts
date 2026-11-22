import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { embeddedBuild } from "../build-identity.js";
import {
  encodeUpdateStatus,
  RUNNER_SELF_UPDATE_PROTOCOL,
  type RetainedSession,
  type RunnerInstalledBuild,
  type RunnerUpdateArch,
  type RunnerUpdateCancelReason,
  type RunnerUpdatePhase,
  type RunnerUpdateReason,
  type RunnerUpdateTarget,
  type SelfUpdateAdvert,
  type UpdateServiceFrame,
  type UpdateStatusFrame,
} from "./protocol.js";
export { trialHelperAvailable } from "./update-trial.js";

import type { FenceRecord, UpdateAdmission } from "./update-admission.js";
import { fileFenceStore } from "./update-fence-store.js";
import {
  runnerHandoff,
  type HandoffFormats,
  type RetainedHost,
  type RunnerCompatibility,
} from "./update-handoff.js";
import { compiledRunnerUpdateKeys } from "./update-keys.js";
import { RUNNER_UPDATE_VERSION } from "./update-manifest.js";
import { parseCompatibility } from "./update-probe.js";
import {
  isSuppressed,
  readTrial,
  sendTrialSignal,
  startRunnerTrial,
  terminalTrial,
  trialLocksAvailable,
  trialMatches,
} from "./update-trial.js";
import {
  RUNNER_UPDATE_UNIT_PREFIX,
  runnerUpdateInstance,
  sha256File,
  type RunnerUpdateLayout,
} from "./update-verify.js";

/*
 * The runner side of the self-update frames. Generic: it stages, decides
 * handoff feasibility at the fence, fences process admission and reports
 * inventory. It never sees Dispatch prompts, schedules or policy.
 */

export type StageReport =
  | {
      outcome: "staged" | "already_staged";
      compatibility: RunnerCompatibility | null;
    }
  | { outcome: "already_installed" }
  | { outcome: "refused"; reason: string; floorVersion?: string };

/**
 * Staging and activation run in separate fixed systemd units. The durable
 * adapter reports journal outcomes and submits authenticated trial decisions.
 */
export type RunnerUpdater = {
  canActivate: boolean;
  activationLocksAvailable?(): Promise<boolean>;
  durable?: {
    read(): ReturnType<typeof readTrial>;
    fenceCleared(): Promise<boolean>;
    signal(
      fence: FenceRecord,
      signal: Parameters<typeof sendTrialSignal>[2]
    ): Promise<void>;
  };
  stage(target: RunnerUpdateTarget): Promise<StageReport>;
  /** A persisted failed digest needs an explicit retry. */
  suppressed(target: RunnerUpdateTarget): Promise<boolean>;
  /**
   * Hand the persisted fence to the root updater: verify the supervisor
   * stopped, rename, start the candidate (which reads the fence from disk and
   * starts fenced) and run its trial. Rejects only if nothing was swapped.
   */
  activate(fence: FenceRecord): Promise<void>;
  confirm(
    fence: FenceRecord,
    observed: { revision: string; sha256: string }
  ): Promise<void>;
  /** True if the updater owns a trial and will report its outcome. */
  cancelTrial(
    fence: FenceRecord,
    reason: RunnerUpdateCancelReason
  ): Promise<boolean>;
};

export type UpdateIdentity = {
  os: "linux";
  arch: RunnerUpdateArch;
  version: string;
  revision: string;
  sha256: string;
  handoff: HandoffFormats;
};

export type HandoffInventory = {
  retained: RetainedHost[];
  requiresQuiescence: boolean;
  /** Live hosts at the boundary, verified or not. */
  live: number;
};

type StageResult = {
  reason: RunnerUpdateReason;
  compatibility: RunnerCompatibility | null;
  floorVersion?: string;
  downloadFailed?: true;
};

type Attempt = {
  attemptId: string;
  target: RunnerUpdateTarget;
  result?: StageResult;
};

const sameTarget = (a: RunnerUpdateTarget, b: RunnerUpdateTarget) =>
  a.version === b.version &&
  a.os === b.os &&
  a.arch === b.arch &&
  a.sha256 === b.sha256 &&
  a.revision === b.revision;

/** Bind a staging report to the offered digest and full revision. */
export function stageResult(
  report: StageReport,
  target: RunnerUpdateTarget
): StageResult {
  switch (report.outcome) {
    case "staged":
    case "already_staged": {
      const compatibility = report.compatibility;
      // A probe of other bytes cannot authorize this candidate.
      if (
        compatibility &&
        (compatibility.version !== target.version ||
          compatibility.revision !== target.revision)
      )
        return { reason: "verify_failed", compatibility: null };
      return { reason: "ready", compatibility };
    }
    case "already_installed":
      return { reason: "ready", compatibility: null };
    case "refused":
      if (report.reason === "download_failed")
        return {
          reason: "verify_failed",
          compatibility: null,
          downloadFailed: true,
        };
      if (report.reason !== "downgrade" && report.reason !== "version_conflict")
        return { reason: "verify_failed", compatibility: null };
      return {
        reason: "downgrade",
        compatibility: null,
        ...(report.floorVersion && { floorVersion: report.floorVersion }),
      };
  }
}

/** Longer than the five-minute operation deadline, flush margin and grace. */
export const PRE_ACTIVATION_FENCE_TTL_MS = 6 * 60_000;

export function createRunnerUpdateAgent(options: {
  identity: UpdateIdentity | null;
  admission: UpdateAdmission;
  updater: RunnerUpdater;
  inspect: (candidate: HandoffFormats | null) => Promise<HandoffInventory>;
  log?: (message: string) => void;
}) {
  const { identity, admission, updater, inspect } = options;
  const log = options.log ?? ((message) => console.warn(message));
  let attempt: Attempt | null = null;
  let send: ((frame: UpdateStatusFrame) => void) | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiredAttempt: string | undefined;
  let activationPending = false;
  let reportedPhase: string | undefined;
  let checkingTrial = false;
  let readyFence: FenceRecord | undefined;
  let kickedFence: FenceRecord | undefined;
  const stagings = new Map<string, Promise<StageReport>>();

  const installed = (): RunnerInstalledBuild => ({
    version: identity!.version,
    revision: identity!.revision,
    sha256: identity!.sha256,
  });

  function status(
    attemptId: string,
    phase: RunnerUpdatePhase,
    extra: {
      reason?: RunnerUpdateReason;
      floorVersion?: string;
      downloadFailed?: true;
      fenceCleared?: true;
      retained?: RetainedSession[];
      requiresQuiescence?: boolean;
    } = {}
  ) {
    send?.(
      encodeUpdateStatus({
        type: "update_status",
        attemptId,
        phase,
        ...extra,
        installed: installed(),
      })
    );
  }
  const stageStatus = (attemptId: string, result?: StageResult) =>
    status(attemptId, "deferred", {
      reason: result?.reason ?? "staging",
      ...(result?.downloadFailed && { downloadFailed: true }),
      ...(result?.floorVersion && { floorVersion: result.floorVersion }),
    });
  const unknown = (attemptId: string) =>
    status(attemptId, "deferred", { reason: "cancelled" });

  async function replayTerminal(attemptId: string) {
    const trial = await updater.durable?.read();
    if (trial && trial.fence.attemptId === attemptId && terminalTrial(trial))
      return status(attemptId, trial.phase, { reason: trial.reason });
    return unknown(attemptId);
  }

  async function reconcileTrial(replay = false) {
    if (!identity || !updater.durable || checkingTrial) return;
    checkingTrial = true;
    try {
      const current = admission.current;
      const trial = await updater.durable.read();
      if (current?.phase === "activating" && trialMatches(trial, current)) {
        if (terminalTrial(trial!)) {
          if (!(await updater.durable.fenceCleared())) return;
          if (admission.current === current) {
            if (attempt?.attemptId === current.attemptId) attempt = null;
            admission.releaseFromUpdater();
          }
        } else if (trial!.phase === "starting" && readyFence !== current) {
          if (
            installed().revision !== current.target.revision ||
            installed().sha256 !== current.target.sha256 ||
            installed().version !== current.target.version
          ) {
            await updater.durable.signal(current, {
              kind: "reject",
              reason: "verify_failed",
            });
          } else {
            await updater.durable.signal(current, {
              kind: "ready",
              pid: process.pid,
            });
          }
          readyFence = current;
        }
      } else if (
        current?.phase === "activating" &&
        send &&
        kickedFence !== current
      ) {
        kickedFence = current;
        await updater.activate(current);
      }
      if (
        trial &&
        (terminalTrial(trial) ||
          (admission.current && trialMatches(trial, admission.current)))
      ) {
        const key = `${trial.fence.attemptId}/${trial.fence.startedAt}/${trial.phase}`;
        if (send && (replay || reportedPhase !== key)) {
          reportedPhase = key;
          if (terminalTrial(trial)) {
            status(trial.fence.attemptId, trial.phase, {
              reason: trial.reason,
            });
          } else {
            status(trial.fence.attemptId, "activating", {
              ...(trial.phase === "trial" && { reason: "trial" }),
              retained: trial.fence.retained,
            });
          }
        }
      }
    } catch (error) {
      log(`Runner update reconciliation failed: ${(error as Error).message}`);
    } finally {
      checkingTrial = false;
    }
  }

  if (identity && updater.durable) {
    // Works while disconnected, so a confirmed candidate can reopen admission
    // even if the acknowledgement was lost with the connection.
    setInterval(() => void reconcileTrial(), 500).unref();
  }

  function armExpiry(fence: FenceRecord) {
    clearTimeout(expiryTimer);
    if (fence.phase === "activating") return;
    const remaining = Math.min(
      PRE_ACTIVATION_FENCE_TTL_MS,
      fence.startedAt + PRE_ACTIVATION_FENCE_TTL_MS - Date.now()
    );
    expiryTimer = setTimeout(
      () => {
        const current = admission.current;
        if (
          !current ||
          current.attemptId !== fence.attemptId ||
          current.startedAt !== fence.startedAt ||
          current.phase === "activating"
        )
          return;
        void release(current.attemptId).then(() => {
          log(`Runner pre-activation fence expired for ${current.attemptId}.`);
          if (send) unknown(current.attemptId);
          else expiredAttempt = current.attemptId;
        });
      },
      Math.max(0, remaining)
    );
    expiryTimer.unref();
  }

  async function release(attemptId: string) {
    clearTimeout(expiryTimer);
    if (attempt?.attemptId === attemptId) attempt = null;
    await admission.release();
  }

  if (identity && admission.current) armExpiry(admission.current);

  function stage(current: Attempt) {
    const { sha256 } = current.target;
    let run = stagings.get(sha256);
    if (!run) {
      run = updater.stage(current.target).finally(() => {
        if (stagings.get(sha256) === run) stagings.delete(sha256);
      });
      stagings.set(sha256, run);
    }
    void run
      .catch((error: Error): StageReport => {
        log(`Runner update staging failed: ${error.message}`);
        return { outcome: "refused", reason: "failed" };
      })
      .then((report) => {
        if (attempt !== current) return;
        current.result = stageResult(report, current.target);
        // A persisted fence for this attempt reports through the fence.
        if (admission.current?.attemptId === current.attemptId) return;
        stageStatus(current.attemptId, current.result);
      });
  }

  function fenceStatus(fence: FenceRecord) {
    if (fence.phase === "fenced")
      status(fence.attemptId, "deferred", {
        reason: "fence_ready",
        retained: fence.retained,
      });
    else if (fence.phase === "activating") {
      if (updater.durable) return reconcileTrial(true);
      status(fence.attemptId, "activating", { retained: fence.retained });
    }
  }

  async function offer(
    frame: Extract<UpdateServiceFrame, { type: "update_offer" }>
  ) {
    const fence = admission.current;
    if (fence || admission.unreadable) {
      if (
        !fence ||
        fence.attemptId !== frame.attemptId ||
        !sameTarget(fence.target, frame.target)
      )
        return unknown(frame.attemptId);
      if (fence.phase === "activating") return fenceStatus(fence);
      // A restarted supervisor rebinds staging for its persisted attempt.
      if (attempt?.attemptId !== frame.attemptId) {
        attempt = { attemptId: frame.attemptId, target: fence.target };
        stage(attempt);
      }
      return fenceStatus(fence);
    }
    if (updater.durable) {
      const last = await updater.durable.read();
      if (
        last &&
        terminalTrial(last) &&
        last.phase !== "deferred" &&
        last.fence.attemptId === frame.attemptId &&
        sameTarget(last.fence.target, frame.target)
      )
        return status(frame.attemptId, last.phase, { reason: last.reason });
    }
    if (attempt?.attemptId === frame.attemptId) {
      if (!sameTarget(attempt.target, frame.target))
        return unknown(frame.attemptId);
      return stageStatus(frame.attemptId, attempt.result);
    }
    if (frame.target.arch !== identity!.arch)
      return status(frame.attemptId, "deferred", { reason: "verify_failed" });
    if (frame.target.sha256 === identity!.sha256)
      return status(frame.attemptId, "confirmed");
    if (!frame.retry && (await updater.suppressed(frame.target)))
      return status(frame.attemptId, "deferred", { reason: "suppressed" });
    // A new offer supersedes any earlier attempt that has not fenced.
    if (admission.closed) return unknown(frame.attemptId);
    attempt = { attemptId: frame.attemptId, target: frame.target };
    status(frame.attemptId, "deferred", { reason: "staging" });
    stage(attempt);
  }

  async function boundary(fence: FenceRecord) {
    const compatibility =
      attempt?.attemptId === fence.attemptId
        ? (attempt.result?.compatibility ?? null)
        : null;
    let inventory: HandoffInventory;
    try {
      inventory = await inspect(compatibility?.handoff ?? null);
    } catch (error) {
      log(`Runner update inventory failed: ${(error as Error).message}`);
      if (admission.current !== fence || activationPending) return;
      await release(fence.attemptId);
      return status(fence.attemptId, "deferred", {
        reason: "operations_pending",
      });
    }
    // A cancel during inspection already replied.
    if (admission.current !== fence || activationPending) return;
    const retained = inventory.retained.map(({ sessionId, instanceId }) => ({
      sessionId,
      instanceId,
    }));
    if (
      !fence.retainSessions ? inventory.live > 0 : inventory.requiresQuiescence
    ) {
      await release(fence.attemptId);
      return status(fence.attemptId, "deferred", {
        reason: fence.retainSessions
          ? "incompatible_handoff"
          : "operations_pending",
        retained,
        requiresQuiescence: inventory.requiresQuiescence,
      });
    }
    await admission.closeTerminals();
    if (admission.current !== fence || activationPending) return;
    try {
      if (!(await admission.advance("fenced", retained))) return;
    } catch (error) {
      log(
        `Runner update fence could not be saved: ${(error as Error).message}`
      );
      if (admission.current !== fence || activationPending) return;
      await release(fence.attemptId);
      return status(fence.attemptId, "deferred", { reason: "cancelled" });
    }
    status(fence.attemptId, "deferred", {
      reason: "fence_ready",
      retained,
      ...(fence.retainSessions && { requiresQuiescence: false }),
    });
  }

  async function fence(
    frame: Extract<UpdateServiceFrame, { type: "update_fence" }>
  ) {
    const current = admission.current;
    if (current) {
      if (activationPending) return;
      if (current.attemptId !== frame.attemptId)
        return unknown(frame.attemptId);
      if (current.phase === "activating") return fenceStatus(current);
      // Draining replies when it finishes.
      if (current.phase === "fencing") return;
      if (attempt?.attemptId !== frame.attemptId || !attempt.result)
        return status(frame.attemptId, "deferred", { reason: "staging" });
      // Re-inspect behind the closed gate for an authoritative set.
      return boundary(current);
    }
    if (admission.unreadable || attempt?.attemptId !== frame.attemptId)
      return unknown(frame.attemptId);
    if (attempt.result?.reason !== "ready")
      return stageStatus(frame.attemptId, attempt.result);
    const draining = admission.fence({
      format: 1,
      attemptId: attempt.attemptId,
      target: attempt.target,
      retainSessions: frame.retainSessions,
      phase: "fencing",
      retained: [],
    });
    const currentFence = admission.current;
    if (currentFence) armExpiry(currentFence);
    const outcome = await draining;
    if (outcome === "cancelled") return;
    if (outcome === "timeout")
      return status(frame.attemptId, "deferred", {
        reason: "operations_pending",
      });
    if (outcome === "store_failed")
      return status(frame.attemptId, "deferred", { reason: "cancelled" });
    if (currentFence && admission.current === currentFence)
      await boundary(currentFence);
  }

  async function activate(
    frame: { attemptId: string },
    isCurrent: () => boolean
  ) {
    const current = admission.current;
    if (!current || current.attemptId !== frame.attemptId)
      return unknown(frame.attemptId);
    if (current.phase === "fencing") return;
    if (current.phase === "activating") return fenceStatus(current);
    if (activationPending) return;
    if (!updater.canActivate) {
      await release(frame.attemptId);
      return unknown(frame.attemptId);
    }
    const locksAvailable = await (updater.activationLocksAvailable?.() ?? true);
    if (admission.current !== current || activationPending) return;
    if (!locksAvailable) {
      await release(frame.attemptId);
      return status(frame.attemptId, "deferred", {
        reason: "operations_pending",
      });
    }
    clearTimeout(expiryTimer);
    activationPending = true;
    try {
      if (!(await admission.advance("activating"))) return;
    } catch (error) {
      log(
        `Runner update activation could not be saved: ${(error as Error).message}`
      );
      if (admission.current === current) {
        armExpiry(current);
        return fenceStatus(current);
      }
      return;
    } finally {
      activationPending = false;
    }
    status(frame.attemptId, "activating", { retained: current.retained });
    const activating = admission.current!;
    kickedFence = activating;
    try {
      if (!isCurrent() && updater.durable)
        await updater.durable.signal(activating, { kind: "disconnect" });
      await updater.activate(activating);
    } catch (error) {
      // A systemctl failure is ambiguous. The durable helper or the next
      // connection reconciles the request without reopening the fence.
      if (updater.durable) throw error;
      // The in-process seam reports a definite pre-swap refusal.
      log(`Runner update activation refused: ${(error as Error).message}`);
      if (admission.current?.attemptId === frame.attemptId)
        await release(frame.attemptId);
      status(frame.attemptId, "deferred", { reason: "cancelled" });
    }
  }

  async function confirm(
    frame: Extract<UpdateServiceFrame, { type: "update_confirm" }>,
    isCurrent: () => boolean
  ) {
    const current = admission.current;
    if (!current) return replayTerminal(frame.attemptId);
    if (current.attemptId !== frame.attemptId) return unknown(frame.attemptId);
    if (current.phase !== "activating") return fenceStatus(current);
    if (updater.durable) {
      const trial = await updater.durable.read();
      if (!isCurrent()) return;
      if (!trialMatches(trial, current) || trial!.phase !== "trial")
        return fenceStatus(current);
      if (
        frame.revision !== current.target.revision ||
        frame.sha256 !== current.target.sha256
      ) {
        return updater.durable.signal(current, {
          kind: "reject",
          reason: "verify_failed",
        });
      }
      const inventory = await inspect(identity!.handoff).catch(() => null);
      if (!isCurrent() || admission.current !== current) return;
      if (
        !inventory ||
        !current.retained.every((expected) =>
          inventory.retained.some(
            (host) =>
              host.sessionId === expected.sessionId &&
              host.instanceId === expected.instanceId
          )
        )
      ) {
        return updater.durable.signal(current, {
          kind: "reject",
          reason: "reattach_failed",
        });
      }
    } else if (
      frame.revision !== current.target.revision ||
      frame.sha256 !== current.target.sha256
    ) {
      return fenceStatus(current);
    }
    await updater.confirm(current, {
      revision: frame.revision,
      sha256: frame.sha256,
    });
    if (updater.durable) return;
    if (admission.current === current) await release(frame.attemptId);
    status(frame.attemptId, "confirmed");
  }

  async function cancel(
    frame: Extract<UpdateServiceFrame, { type: "update_cancel" }>
  ) {
    const current = admission.current;
    const clearsUnreadable = !current && admission.unreadable;
    if (clearsUnreadable) {
      log(
        "Runner update fence state was unreadable; cancelled by the service."
      );
      await release(frame.attemptId);
    } else if (!current && updater.durable) {
      return replayTerminal(frame.attemptId);
    } else if (current && current.attemptId !== frame.attemptId) {
      return unknown(frame.attemptId);
    } else if (current) {
      if (
        current.phase === "activating" &&
        (await updater.cancelTrial(current, frame.reason))
      )
        return;
      if (admission.current === current) await release(frame.attemptId);
    }
    if (attempt?.attemptId === frame.attemptId) attempt = null;
    status(frame.attemptId, "deferred", {
      reason: "cancelled",
      ...(clearsUnreadable && { fenceCleared: true }),
    });
  }

  return {
    advert(): SelfUpdateAdvert | undefined {
      if (!identity) return undefined;
      const pending = admission.current?.attemptId;
      return {
        protocol: RUNNER_SELF_UPDATE_PROTOCOL,
        os: identity.os,
        arch: identity.arch,
        version: identity.version,
        revision: identity.revision,
        installedSha256: identity.sha256,
        handoff: {
          reads: [...identity.handoff.reads],
          writes: identity.handoff.writes,
        },
        ...(pending && { pendingAttemptId: pending }),
        ...(admission.unreadable && { fenceUnreadable: true }),
      };
    },
    /**
     * One authenticated connection. Statuses go only to the latest one; a
     * runner without the capability never receives frames to handle.
     */
    connect(sendStatus: (frame: UpdateStatusFrame) => void) {
      send = sendStatus;
      reportedPhase = undefined;
      kickedFence = undefined;
      const isCurrent = () => send === sendStatus;
      void reconcileTrial(true);
      if (expiredAttempt) {
        unknown(expiredAttempt);
        expiredAttempt = undefined;
      }
      return {
        receive(frame: UpdateServiceFrame): Promise<void> {
          if (!identity || send !== sendStatus) return Promise.resolve();
          const handle = async () => {
            switch (frame.type) {
              case "update_offer":
                return offer(frame);
              case "update_fence":
                return fence(frame);
              case "update_activate":
                return activate(frame, isCurrent);
              case "update_confirm":
                return confirm(frame, isCurrent);
              case "update_cancel":
                return cancel(frame);
            }
          };
          return handle().catch((error: Error) =>
            log(`Runner update ${frame.type} failed: ${error.message}`)
          );
        },
        close() {
          if (!isCurrent()) return;
          send = undefined;
          const fence = admission.current;
          if (
            updater.durable &&
            fence?.phase === "activating" &&
            installed().sha256 !== fence.target.sha256
          ) {
            void updater.durable
              .signal(fence, { kind: "disconnect" })
              .catch((error: Error) =>
                log(
                  `Runner update disconnect could not be recorded: ${error.message}`
                )
              );
          }
        },
      };
    },
  };
}

const UPDATER_UNIT = "/etc/systemd/system/dispatch-runner-update@.service";
const STAGE_TIMEOUT_MS = 41 * 60_000;
const execute = promisify(execFile);

async function readPrivateJson(file: string, uid: number) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.mode & 0o077 ||
      stat.size > 16 * 1024
    )
      throw new Error("Runner update record is not private");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

/** Read the staging unit's last result, only if it names this target. */
export async function readStageRecord(
  layout: RunnerUpdateLayout,
  target: RunnerUpdateTarget,
  startedAt: number,
  uid = 0
): Promise<StageReport | null> {
  const record = (await readPrivateJson(
    path.join(layout.state, "last-stage.json"),
    uid
  ).catch(() => null)) as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return null;
  const named = record.target as Record<string, unknown> | undefined;
  const at = typeof record.at === "string" ? Date.parse(record.at) : NaN;
  if (
    !named ||
    named.sha256 !== target.sha256 ||
    named.version !== target.version ||
    named.arch !== target.arch ||
    !(at >= startedAt - 1000)
  )
    return null;
  switch (record.outcome) {
    case "staged":
    case "already_staged": {
      let compatibility: RunnerCompatibility | null = null;
      if (record.compatibility) {
        try {
          compatibility = parseCompatibility(
            JSON.stringify(record.compatibility),
            target.version
          );
        } catch {
          compatibility = null;
        }
      }
      return { outcome: record.outcome, compatibility };
    }
    case "already_installed":
      return { outcome: "already_installed" };
    case "refused": {
      const floor = record.floorVersion;
      return {
        outcome: "refused",
        reason: typeof record.reason === "string" ? record.reason : "failed",
        // The protocol bounds a version to 64 characters.
        ...(typeof floor === "string" &&
          floor.length <= 64 &&
          RUNNER_UPDATE_VERSION.test(floor) && { floorVersion: floor }),
      };
    }
    default:
      return null;
  }
}

export function systemdRunnerUpdater(
  layout: RunnerUpdateLayout,
  canActivate = false
): RunnerUpdater {
  return {
    canActivate,
    ...(canActivate && {
      activationLocksAvailable: () => trialLocksAvailable(layout),
      durable: {
        read: () => readTrial(layout),
        fenceCleared: async () =>
          (await fileFenceStore(layout.state, 0).read()) === null,
        signal: (
          fence: FenceRecord,
          signal: Parameters<typeof sendTrialSignal>[2]
        ) => sendTrialSignal(layout, fence, signal),
      },
    }),
    async stage(target) {
      const startedAt = Date.now();
      const unit = `${RUNNER_UPDATE_UNIT_PREFIX}${runnerUpdateInstance(target)}.service`;
      // A oneshot `start` returns once staging has finished or failed.
      await execute("/usr/bin/systemctl", ["start", unit], {
        timeout: STAGE_TIMEOUT_MS,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      }).catch(() => {});
      return (
        (await readStageRecord(layout, target, startedAt)) ?? {
          outcome: "refused",
          reason: "failed",
        }
      );
    },
    suppressed: (target) => isSuppressed(layout, target.sha256),
    async activate() {
      if (!canActivate)
        throw new Error("Runner activation helper is unavailable");
      await startRunnerTrial();
    },
    async confirm(fence, observed) {
      if (!canActivate)
        throw new Error("Runner activation helper is unavailable");
      await sendTrialSignal(layout, fence, { kind: "confirm", observed });
    },
    async cancelTrial(fence, reason) {
      if (!canActivate) return false;
      await sendTrialSignal(layout, fence, {
        kind: "reject",
        reason: reason === "trial_failed" ? "reattach_failed" : "cancelled",
      });
      return true;
    },
  };
}

/**
 * The installed identity, only when this process is the installed binary and
 * the root updater, its private state and a trust root are present.
 */
export async function detectSelfUpdate(
  layout: RunnerUpdateLayout,
  unitFile = UPDATER_UNIT
): Promise<UpdateIdentity | null> {
  try {
    const arch = process.arch;
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      (arch !== "x64" && arch !== "arm64") ||
      !embeddedBuild.revision ||
      !RUNNER_UPDATE_VERSION.test(embeddedBuild.version) ||
      compiledRunnerUpdateKeys().size === 0 ||
      (await realpath(process.execPath)) !== layout.installed
    )
      return null;
    const unit = await lstat(unitFile);
    if (!unit.isFile() || unit.uid !== 0 || unit.mode & 0o022) return null;
    for (const dir of [layout.staging, layout.state]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o077)
        return null;
    }
    return {
      os: "linux",
      arch,
      version: embeddedBuild.version,
      revision: embeddedBuild.revision,
      sha256: await sha256File(layout.installed),
      handoff: {
        reads: [...runnerHandoff.reads],
        writes: runnerHandoff.writes,
      },
    };
  } catch {
    return null;
  }
}
