import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { embeddedBuild } from "../build-identity.js";
import {
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
import type { FenceRecord, UpdateAdmission } from "./update-admission.js";
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
  | { outcome: "refused"; reason: string };

/**
 * The root updater. Task 2's staging unit backs `stage`. Activation,
 * confirmation and trial rollback belong to the later activation task; this
 * build has no real implementation of them.
 */
export type RunnerUpdater = {
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
  cancelTrial(
    fence: FenceRecord,
    reason: RunnerUpdateCancelReason
  ): Promise<void>;
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
      return {
        reason:
          report.reason === "downgrade" || report.reason === "version_conflict"
            ? "downgrade"
            : "verify_failed",
        compatibility: null,
      };
  }
}

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
      retained?: RetainedSession[];
      requiresQuiescence?: boolean;
    } = {}
  ) {
    send?.({
      type: "update_status",
      attemptId,
      phase,
      ...extra,
      installed: installed(),
    });
  }
  const unknown = (attemptId: string) =>
    status(attemptId, "deferred", { reason: "cancelled" });

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
        status(current.attemptId, "deferred", {
          reason: current.result.reason,
        });
      });
  }

  function fenceStatus(fence: FenceRecord) {
    if (fence.phase === "fenced")
      status(fence.attemptId, "deferred", {
        reason: "fence_ready",
        retained: fence.retained,
      });
    else if (fence.phase === "activating")
      status(fence.attemptId, "activating");
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
      // A restarted supervisor rebinds staging for its persisted attempt.
      if (attempt?.attemptId !== frame.attemptId) {
        attempt = { attemptId: frame.attemptId, target: fence.target };
        stage(attempt);
      }
      return fenceStatus(fence);
    }
    if (attempt?.attemptId === frame.attemptId) {
      if (!sameTarget(attempt.target, frame.target))
        return unknown(frame.attemptId);
      return status(frame.attemptId, "deferred", {
        reason: attempt.result?.reason ?? "staging",
      });
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
      if (admission.current === fence) await admission.release();
      return status(fence.attemptId, "deferred", {
        reason: "operations_pending",
      });
    }
    // A cancel during inspection already replied.
    if (admission.current !== fence) return;
    const retained = inventory.retained.map(({ sessionId, instanceId }) => ({
      sessionId,
      instanceId,
    }));
    if (
      !fence.retainSessions ? inventory.live > 0 : inventory.requiresQuiescence
    ) {
      await admission.release();
      return status(fence.attemptId, "deferred", {
        reason: fence.retainSessions
          ? "incompatible_handoff"
          : "operations_pending",
        retained,
        requiresQuiescence: inventory.requiresQuiescence,
      });
    }
    await admission.closeTerminals();
    if (admission.current !== fence) return;
    try {
      await admission.advance("fenced", retained);
    } catch (error) {
      log(
        `Runner update fence could not be saved: ${(error as Error).message}`
      );
      await admission.release();
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
      return status(frame.attemptId, "deferred", {
        reason: attempt.result?.reason ?? "staging",
      });
    const outcome = await admission.fence({
      format: 1,
      attemptId: attempt.attemptId,
      target: attempt.target,
      retainSessions: frame.retainSessions,
      phase: "fencing",
      retained: [],
    });
    if (outcome === "cancelled") return;
    if (outcome === "timeout")
      return status(frame.attemptId, "deferred", {
        reason: "operations_pending",
      });
    if (outcome === "store_failed")
      return status(frame.attemptId, "deferred", { reason: "cancelled" });
    await boundary(admission.current!);
  }

  async function activate(frame: { attemptId: string }) {
    const current = admission.current;
    if (!current || current.attemptId !== frame.attemptId)
      return unknown(frame.attemptId);
    if (current.phase === "fencing") return;
    if (current.phase === "activating") return fenceStatus(current);
    try {
      await admission.advance("activating");
    } catch (error) {
      log(
        `Runner update activation could not be saved: ${(error as Error).message}`
      );
      return fenceStatus(current);
    }
    status(frame.attemptId, "activating");
    try {
      await updater.activate(admission.current!);
    } catch (error) {
      // Nothing was swapped. Reopen admission before reporting.
      log(`Runner update activation refused: ${(error as Error).message}`);
      if (admission.current?.attemptId === frame.attemptId)
        await admission.release();
      if (attempt?.attemptId === frame.attemptId) attempt = null;
      status(frame.attemptId, "deferred", { reason: "cancelled" });
    }
  }

  async function confirm(
    frame: Extract<UpdateServiceFrame, { type: "update_confirm" }>
  ) {
    const current = admission.current;
    if (!current || current.attemptId !== frame.attemptId)
      return unknown(frame.attemptId);
    if (
      current.phase !== "activating" ||
      frame.revision !== current.target.revision ||
      frame.sha256 !== current.target.sha256
    )
      return fenceStatus(current);
    await updater.confirm(current, {
      revision: frame.revision,
      sha256: frame.sha256,
    });
    if (admission.current === current) await admission.release();
    if (attempt?.attemptId === frame.attemptId) attempt = null;
    status(frame.attemptId, "confirmed");
  }

  async function cancel(
    frame: Extract<UpdateServiceFrame, { type: "update_cancel" }>
  ) {
    const current = admission.current;
    if (!current && admission.unreadable) {
      log(
        "Runner update fence state was unreadable; cancelled by the service."
      );
      await admission.release();
    } else if (current && current.attemptId !== frame.attemptId) {
      return unknown(frame.attemptId);
    } else if (current?.phase === "activating") {
      // The updater owns the trial and reports its own outcome.
      return updater.cancelTrial(current, frame.reason);
    } else if (current) {
      await admission.release();
    }
    if (attempt?.attemptId === frame.attemptId) attempt = null;
    status(frame.attemptId, "deferred", { reason: "cancelled" });
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
      };
    },
    /**
     * One authenticated connection. Statuses go only to the latest one; a
     * runner without the capability never receives frames to handle.
     */
    connect(sendStatus: (frame: UpdateStatusFrame) => void) {
      send = sendStatus;
      return {
        receive(frame: UpdateServiceFrame): Promise<void> {
          if (!identity) return Promise.resolve();
          const handle = async () => {
            switch (frame.type) {
              case "update_offer":
                return offer(frame);
              case "update_fence":
                return fence(frame);
              case "update_activate":
                return activate(frame);
              case "update_confirm":
                return confirm(frame);
              case "update_cancel":
                return cancel(frame);
            }
          };
          return handle().catch((error: Error) =>
            log(`Runner update ${frame.type} failed: ${error.message}`)
          );
        },
        close() {
          if (send === sendStatus) send = undefined;
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
    case "refused":
      return {
        outcome: "refused",
        reason: typeof record.reason === "string" ? record.reason : "failed",
      };
    default:
      return null;
  }
}

/** Task 2's root staging unit. The activation steps are not in this build. */
export function systemdRunnerUpdater(
  layout: RunnerUpdateLayout
): RunnerUpdater {
  const unavailable = () =>
    Promise.reject(
      new Error("Runner activation is not available in this build.")
    );
  return {
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
    suppressed: async () => false,
    activate: unavailable,
    confirm: unavailable,
    cancelTrial: unavailable,
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
