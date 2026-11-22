import { randomUUID } from "node:crypto";
import type { RunnerUpdateAction, RunnerUpdateView } from "@dispatch/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import type { RunnerArtifactSource } from "../../server/runner-artifacts.js";
import { resumeAgentSchema } from "../../update-recovery/resume-receipt.js";
import type { AgentManager } from "../manager.js";
import {
  endsUpdateAttempt,
  type RetainedSession,
  type RunnerUpdateCancelReason,
  type RunnerUpdateTarget,
  type SelfUpdateAdvert,
} from "./protocol.js";
import {
  RunnerRequestError,
  type RemoteRunnerService,
  type RunnerUpdateEvent,
} from "./service.js";
import type { RunnerHoldOutcome, RunnerUpdateHolds } from "./update-hold.js";
import { privateStateFile } from "./update-state-file.js";
import { compareRunnerVersions } from "./update-verify.js";

/*
 * Dispatch's side of an operator-requested runner update. One attempt per
 * runner:
 *
 *   staging ─ready→ settling ─fence_ready→ switching ─trial→ confirming
 *      └───────────────┴──────────────┴─────────────────┴──→ cancelling
 *
 * Incompatible hosts drain before settling with an empty retained set.
 * Once the runner reports an outcome, Dispatch resumes the stopped hosts
 * before releasing held work. Work goes on during staging, and is held
 * before the first fence. The runner owns the swap and its rollback.
 */

/** Phase budgets. Each is saved as a deadline and never extended by a restart. */
export const UPDATE_TIMING = {
  stagingMs: 5 * 60_000,
  /** The runner's drain and its own six-minute fence expiry. */
  settlingMs: 6.5 * 60_000,
  /** Retained hosts must be attached before the switch may happen. */
  attachMs: 30_000,
  /** The runner's four-minute trial, the swap before it and the restore. */
  switchingMs: 5.5 * 60_000,
  /** Give up inside the trial, so the runner records why it rolled back. */
  confirmingMs: 3 * 60_000,
  cancelMs: 15_000,
  rollbackMs: 60_000,
  confirmRetryMs: 5_000,
  tickMs: 1_000,
} as const;

/** The task-5 hold outlasts every phase it covers. */
export const UPDATE_HOLD_BOUND_MS = 20 * 60_000;
const DRAIN_WAIT_MS = 2 * 60 * 60_000;
const DRAIN_HOLD_BOUND_MS = DRAIN_WAIT_MS + UPDATE_HOLD_BOUND_MS;

const targetSchema = z.object({
  version: z.string(),
  os: z.literal("linux"),
  arch: z.enum(["x64", "arm64"]),
  sha256: z.string(),
  revision: z.string(),
});

const outcomeSchema = z.object({
  state: z.enum(["updated", "rolled_back", "deferred", "needs_idle"]),
  reason: z.string().optional(),
  floorVersion: z.string().optional(),
});

const attemptSchema = z.object({
  id: z.string().uuid(),
  /** Absent only for a runner's attempt that Dispatch has no record of. */
  target: targetSchema.optional(),
  retry: z.boolean(),
  phase: z.enum([
    "staging",
    "settling",
    "draining",
    "resuming",
    "switching",
    "confirming",
    "cancelling",
  ]),
  deadline: z.number(),
  confirmBy: z.number().optional(),
  /** The runner's authoritative set from `fence_ready`. */
  retained: z
    .array(z.object({ sessionId: z.string(), instanceId: z.string() }))
    .max(1024)
    .optional(),
  /** Activation was requested: the runner's updater now owns recovery. */
  activated: z.boolean().optional(),
  /** Why Dispatch cancelled. */
  reason: z.string().optional(),
  outcome: outcomeSchema.optional(),
  drain: z
    .object({
      retainedIds: z.array(z.string()).max(1024),
      waiting: z.number().int().nonnegative().optional(),
      agents: z.array(resumeAgentSchema).max(10_000),
      result: outcomeSchema.optional(),
    })
    .optional(),
});
type Attempt = z.infer<typeof attemptSchema>;
type Outcome = NonNullable<Attempt["outcome"]>;

const runnerState = z.object({
  runnerId: z.string().min(1).max(256),
  attempt: attemptSchema,
  /** The last confirmed target: host recycling resumes towards it. */
  confirmed: z
    .object({
      attemptId: z.string().uuid(),
      revision: z.string(),
      sha256: z.string(),
    })
    .optional(),
  /** A build the runner suppresses until an explicit retry. */
  failed: z.object({ version: z.string(), revision: z.string() }).optional(),
});
export type RunnerUpdateRecord = z.infer<typeof runnerState>;

const stateFile = z.object({
  format: z.literal(1),
  runners: z.array(runnerState).max(1000),
});

export type RunnerUpdateStore = {
  read(): Promise<RunnerUpdateRecord[]>;
  write(records: RunnerUpdateRecord[]): Promise<void>;
};

/**
 * Beside `holds.json`. Losing it ends an attempt: a runner that still
 * reports one is held while that attempt is cancelled.
 */
export function fileRunnerUpdateStore(
  file: string,
  logger?: Pick<FastifyBaseLogger, "warn">
): RunnerUpdateStore {
  const state = privateStateFile({
    file,
    schema: stateFile,
    unreadable: "runner update attempt state is unreadable; starting empty",
    logger,
  });
  return {
    read: async () => (await state.read())?.runners ?? [],
    write: (runners) => state.write({ format: 1, runners }),
  };
}

const INELIGIBLE = {
  stale_drain: "This drain is no longer waiting.",
  not_ready: "Dispatch is still starting. Try again in a moment.",
  offline: "The runner is offline.",
  unsupported:
    "This runner can’t update itself. Use the update command on the runner.",
  update_in_progress: "An update is already running on this runner.",
  no_artifact:
    "Dispatch has no signed build for this runner’s architecture. Use the update command on the runner.",
  runner_newer:
    "The runner is newer than Dispatch. Dispatch doesn’t downgrade runners.",
  up_to_date: "The runner is already up to date.",
  same_version:
    "The runner has a different build of the same version. Use the update command on the runner.",
  needs_retry: "This build failed on this runner. Use Retry to try it again.",
} as const;
type IneligibleCode = keyof typeof INELIGIBLE;

export class RunnerUpdateIneligible extends RunnerRequestError {
  constructor(
    readonly code: IneligibleCode | "not_found",
    /** The attempt in the way, for `update_in_progress`. */
    readonly attemptId?: string
  ) {
    super(
      code === "not_found" ? 404 : 409,
      code === "not_found" ? "Runner not found." : INELIGIBLE[code]
    );
  }
}

type CoordinatorService = Pick<
  RemoteRunnerService,
  | "activateUpdate"
  | "cancelUpdate"
  | "confirmUpdate"
  | "connectedRunnerIds"
  | "connectionEpoch"
  | "fenceUpdate"
  | "isRegistered"
  | "offerUpdate"
  | "onConnectionChange"
  | "onUpdateStatus"
  | "selfUpdate"
>;

type CoordinatorAgents = Pick<
  AgentManager,
  | "attachRunnerSession"
  | "isRunnerSessionAttached"
  | "runnerHostRecycleProgress"
  | "settleRunnerHostRecycling"
  | "startRunnerHostRecycling"
  | "stopRunnerHostRecycling"
  | "runnerDrainHosts"
  | "stopRunnerHostForDrain"
  | "resumeRunnerDrainHost"
  | "setRunnerDrainReceipt"
>;

export class RunnerUpdateCoordinator {
  private readonly records = new Map<string, RunnerUpdateRecord>();
  /** Work for one runner runs in arrival order. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly requests = new Map<string, Promise<{ attemptId: string }>>();
  /** The connection each runner was last reconciled on. */
  private readonly resumed = new Map<string, number>();
  /** The connection that reported `activating/trial`. */
  private readonly trials = new Map<string, number>();
  private readonly confirms = new Map<string, number>();
  private readonly waiting = new Map<string, number>();
  private readonly drainCancellations = new Set<string>();
  private readonly attaching = new Set<string>();
  private readonly ticking = new Set<string>();
  /** Between stopping a recycling pass and the attempt that replaces it. */
  private readonly opening = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private readonly unsubscribe: Array<() => unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private markStarted!: () => void;
  /** Frames that arrive while Dispatch boots wait for the loaded state. */
  private readonly whenStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly now: () => number;

  constructor(
    private readonly options: {
      service: CoordinatorService;
      holds: Pick<RunnerUpdateHolds, "begin" | "current" | "release">;
      agents: CoordinatorAgents;
      store: RunnerUpdateStore;
      /** This controller's signed update builds, by architecture. */
      artifacts: () =>
        | Pick<RunnerArtifactSource, "getUpdate" | "updateEnabled">
        | undefined;
      /** This controller's own build, the only one it offers or confirms. */
      build: { version: string; revision: string | null };
      logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = [
      options.service.onConnectionChange((runnerId) =>
        this.background(runnerId, () => this.reconnected(runnerId))
      ),
      options.service.onUpdateStatus((event) =>
        this.background(event.runnerId, () => this.received(event))
      ),
    ];
  }

  async load(): Promise<void> {
    for (const record of await this.options.store.read()) {
      this.records.set(record.runnerId, record);
      this.syncReceipt(record);
    }
  }

  /**
   * After boot recovery, so released work reaches a started service. Frames
   * and connections that arrived meanwhile are handled only after it.
   */
  async start(): Promise<void> {
    if (this.started) return;
    for (const [runnerId, { attempt }] of [...this.records]) {
      if (attempt.outcome)
        // Dispatch stopped between saving an outcome and releasing its hold.
        this.release(runnerId, attempt.id, holdOutcome(attempt.outcome));
      else if (
        attempt.phase !== "cancelling" &&
        attempt.phase !== "resuming" &&
        !this.isOwnBuild(attempt.target)
      )
        // Never offer or confirm another Dispatch build's target. Without a
        // confirmation the runner's updater restores its previous binary.
        await this.record(
          runnerId,
          this.cancelling(attempt, "dispatch_changed")
        );
    }
    if (this.closed) return;
    this.started = true;
    this.markStarted();
    for (const runnerId of new Set([
      ...this.records.keys(),
      ...this.options.service.connectedRunnerIds(),
    ]))
      this.background(runnerId, () => this.reconnected(runnerId));
    this.timer = setInterval(() => void this.tick(), UPDATE_TIMING.tickMs);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.markStarted();
  }

  /** Start one attempt. Simultaneous requests for a runner share it. */
  request(
    runnerId: string,
    action: RunnerUpdateAction
  ): Promise<{ attemptId: string }> {
    const running = this.requests.get(runnerId);
    if (running) return running;
    const request = this.open(runnerId, action).finally(() =>
      this.requests.delete(runnerId)
    );
    this.requests.set(runnerId, request);
    return request;
  }

  async cancelDrain(runnerId: string, attemptId: string) {
    if (!this.options.service.isRegistered(runnerId))
      throw new RunnerUpdateIneligible("not_found");
    if (!this.started) throw new RunnerUpdateIneligible("not_ready");
    const valid = (attempt: Attempt | undefined): attempt is Attempt =>
      attempt?.id === attemptId && attempt.phase === "draining";
    if (!valid(this.active(runnerId)))
      throw new RunnerUpdateIneligible("stale_drain");
    this.drainCancellations.add(attemptId);
    try {
      return await this.enqueue(runnerId, async () => {
        const attempt = this.active(runnerId);
        if (!valid(attempt)) throw new RunnerUpdateIneligible("stale_drain");
        // The incompatible fence was released before the waiting phase.
        await this.finish(runnerId, attempt, {
          state: "deferred",
          reason: "drain_cancelled",
        });
        return { attemptId };
      });
    } finally {
      this.drainCancellations.delete(attemptId);
    }
  }

  view(runnerId: string): RunnerUpdateView | undefined {
    const { service, agents, artifacts, build } = this.options;
    const record = this.records.get(runnerId);
    const advert = service.selfUpdate(runnerId)?.advert;
    const attempt = this.active(runnerId);
    if (attempt)
      return {
        attempt: {
          id: attempt.id,
          phase: attempt.phase,
          ...(attempt.phase === "draining" && {
            agents:
              this.waiting.get(runnerId) ??
              attempt.drain!.waiting ??
              attempt.drain!.retainedIds.length,
          }),
          ...(attempt.phase === "resuming" && {
            agents: attempt.drain!.agents.length,
          }),
          ...(attempt.target && { version: attempt.target.version }),
          ...(this.options.holds.current(runnerId)?.attemptId ===
            attempt.id && { held: true }),
        },
      };

    const view: RunnerUpdateView = {};
    const last = record?.attempt;
    if (
      last?.outcome &&
      last.outcome.state !== "needs_idle" &&
      this.showsResult(last, last.outcome, advert)
    )
      view.result = {
        ...last.outcome,
        ...(last.target && { version: last.target.version }),
      };
    if (
      advert &&
      build.revision &&
      !advert.pendingAttemptId &&
      artifacts()?.updateEnabled &&
      versionOrder(build.version, advert.version) === 1
    )
      view.available = {
        version: build.version,
        action: this.suppressed(runnerId) ? "retry" : "update",
      };
    const oldBuild = agents.runnerHostRecycleProgress(runnerId)?.oldBuild;
    if (oldBuild) view.previousBuildAgents = oldBuild;
    return Object.keys(view).length ? view : undefined;
  }

  /** One pass over the live attempts: evidence, then deadlines. */
  async tick(): Promise<void> {
    if (!this.started || this.closed) return;
    await Promise.all(
      [...this.records.keys()].map(async (runnerId) => {
        if (!this.active(runnerId) || this.ticking.has(runnerId)) return;
        this.ticking.add(runnerId);
        try {
          await this.enqueue(runnerId, () => this.advance(runnerId));
        } catch (error) {
          this.options.logger.error(
            { err: error, runnerId },
            "runner update check failed"
          );
        } finally {
          this.ticking.delete(runnerId);
        }
      })
    );
  }

  // --- Requests ---

  private async open(
    runnerId: string,
    action: RunnerUpdateAction
  ): Promise<{ attemptId: string }> {
    const { service, agents, artifacts, build, logger } = this.options;
    if (!service.isRegistered(runnerId))
      throw new RunnerUpdateIneligible("not_found");
    if (!this.started) throw new RunnerUpdateIneligible("not_ready");
    const { arch } = this.eligible(runnerId, action).advert;
    let sha256: string;
    try {
      const { manifest } = await artifacts()!.getUpdate(arch);
      sha256 = manifest.sha256;
    } catch (error) {
      logger.warn(
        { err: error, runnerId, arch },
        "no signed runner update build"
      );
      throw new RunnerUpdateIneligible("no_artifact");
    }
    const target: RunnerUpdateTarget = {
      version: build.version,
      os: "linux",
      arch,
      sha256,
      revision: build.revision!,
    };
    // A restart already past host shutdown must finish before the attempt
    // starts, or it could meet the hold at `ready` with its agent down.
    this.opening.add(runnerId);
    try {
      await agents.settleRunnerHostRecycling(runnerId);
      return await this.enqueue(runnerId, async () => {
        const { advert, epoch } = this.eligible(runnerId, action);
        const attempt: Attempt = {
          id: randomUUID(),
          target,
          retry: action === "retry",
          phase: "staging",
          deadline: this.now() + UPDATE_TIMING.stagingMs,
        };
        await this.save({ ...this.records.get(runnerId), runnerId, attempt });
        this.resumed.set(runnerId, epoch);
        this.forgetTrial(runnerId);
        logger.info(
          { runnerId, attemptId: attempt.id, target, action },
          "runner update requested"
        );
        this.sendOffer(runnerId, attempt, advert, epoch);
        return { attemptId: attempt.id };
      });
    } finally {
      this.opening.delete(runnerId);
      this.resumeRecycling(runnerId);
    }
  }

  private eligible(runnerId: string, action: RunnerUpdateAction) {
    const { service, artifacts, build } = this.options;
    const refuse = (code: IneligibleCode, attemptId?: string) =>
      new RunnerUpdateIneligible(code, attemptId);
    const running = this.active(runnerId);
    if (running) throw refuse("update_in_progress", running.id);
    if (service.connectionEpoch(runnerId) === undefined)
      throw refuse("offline");
    const live = service.selfUpdate(runnerId);
    if (!live) throw refuse("unsupported");
    const { advert } = live;
    if (advert.pendingAttemptId)
      throw refuse("update_in_progress", advert.pendingAttemptId);
    if (!build.revision || !artifacts()?.updateEnabled)
      throw refuse("no_artifact");
    const order = versionOrder(build.version, advert.version);
    if (order === undefined) throw refuse("unsupported");
    if (order < 0) throw refuse("runner_newer");
    if (order === 0)
      throw refuse(
        advert.revision === build.revision ? "up_to_date" : "same_version"
      );
    if (action === "update" && this.suppressed(runnerId))
      throw refuse("needs_retry");
    return live;
  }

  // --- Connections ---

  private async reconnected(runnerId: string): Promise<void> {
    const { service, agents, holds } = this.options;
    const epoch = service.connectionEpoch(runnerId);
    if (epoch === undefined) {
      if (!service.isRegistered(runnerId))
        agents.stopRunnerHostRecycling(runnerId);
      return;
    }
    if (this.resumed.get(runnerId) === epoch) return;
    this.resumed.set(runnerId, epoch);
    this.forgetTrial(runnerId);
    const advert = service.selfUpdate(runnerId)?.advert;
    const pending = advert?.pendingAttemptId;
    let attempt = this.active(runnerId);

    if (attempt?.phase === "resuming") return this.advance(runnerId);
    if (attempt?.phase === "draining" && !pending)
      return this.advance(runnerId);
    if (attempt && !advert) {
      await this.finish(runnerId, attempt, {
        state: "deferred",
        reason: "unsupported",
      });
      return;
    }
    if (attempt && pending && pending !== attempt.id) {
      await this.finish(runnerId, attempt, {
        state: "deferred",
        reason: "interrupted",
      });
      attempt = undefined;
    }
    if (!attempt) {
      if (pending) return this.adopt(runnerId, pending, epoch);
      const stray = holds.current(runnerId);
      if (stray) this.release(runnerId, stray.attemptId, "fence_released");
      this.resumeRecycling(runnerId);
      return;
    }

    // Nothing waits on an attempt the runner is not fenced for and was not
    // asked to fence.
    if (
      pending ||
      attempt.phase === "settling" ||
      attempt.activated ||
      attempt.drain
    ) {
      if (!(await this.holdOrCancel(runnerId, attempt))) return;
    } else {
      this.releaseOther(runnerId, attempt.id);
    }
    switch (attempt.phase) {
      case "draining":
        // An earlier fence might still be unwinding on this connection.
        await this.cancel(runnerId, attempt, "interrupted");
        return;
      case "cancelling":
        return this.sendCancel(runnerId, attempt, epoch);
      case "staging":
      case "settling":
        if (attempt.retained) {
          // A new connection needs a fresh `fence_ready`.
          attempt = { ...attempt, retained: undefined };
          await this.record(runnerId, attempt);
        }
        if (
          !pending &&
          advert!.installedSha256 !== attempt.target!.sha256 &&
          versionOrder(attempt.target!.version, advert!.version) !== 1
        )
          return this.cancel(runnerId, attempt, "runner_newer");
        return this.sendOffer(runnerId, attempt, advert!, epoch);
      case "switching":
      case "confirming":
        // A fenced runner answers a repeated offer with where it is. One
        // without a fence has ended: a cancel only replays its outcome,
        // while an offer would start staging again.
        if (pending) this.sendOffer(runnerId, attempt, advert!, epoch);
        else this.sendCancel(runnerId, attempt, epoch);
    }
  }

  /** The runner is fenced for an attempt this Dispatch is not running. */
  private async adopt(runnerId: string, id: string, epoch: number) {
    const record = this.records.get(runnerId);
    const known = record?.attempt.id === id ? record.attempt : undefined;
    const activated = known ? known.activated : true;
    const attempt: Attempt = {
      id,
      ...(known?.target && { target: known.target }),
      retry: false,
      phase: "cancelling",
      deadline: this.now() + UPDATE_TIMING.rollbackMs,
      ...(activated && { activated }),
      reason: known?.outcome?.reason ?? "interrupted",
    };
    await this.record(runnerId, attempt);
    try {
      await this.holdFor(runnerId, id);
    } catch (error) {
      this.options.logger.error(
        { err: error, runnerId },
        "could not hold a runner for its pending update"
      );
    }
    this.sendCancel(runnerId, attempt, epoch);
  }

  // --- Statuses ---

  private async received({ runnerId, epoch, status }: RunnerUpdateEvent) {
    const live = this.options.service.selfUpdate(runnerId);
    if (live?.epoch !== epoch) return;
    const attempt = this.records.get(runnerId)?.attempt;
    if (attempt?.id !== status.attemptId || attempt.phase === "resuming")
      return;
    const ended = endsUpdateAttempt(status);
    const { target, outcome } = attempt;

    if (status.phase === "confirmed") {
      if (
        target &&
        (status.installed.sha256 !== target.sha256 ||
          status.installed.revision !== target.revision)
      )
        return;
      if (outcome?.state === "updated") return;
      return this.finish(
        runnerId,
        {
          ...attempt,
          target: target ?? {
            ...status.installed,
            os: "linux",
            arch: live.advert.arch,
          },
        },
        { state: "updated" }
      );
    }
    if (outcome) {
      // Dispatch may have given up before the runner's last word.
      if (
        !ended ||
        outcome.state === "updated" ||
        outcome.state === "rolled_back" ||
        (status.phase === "deferred" && outcome.reason !== "no_response")
      )
        return;
    } else if (!ended) {
      return this.progressed(runnerId, attempt, live.advert, epoch, status);
    }

    if (status.fenceCleared && !outcome && attempt.phase === "staging")
      return this.sendOffer(runnerId, attempt, live.advert, epoch);
    if (
      status.phase === "deferred" &&
      (status.reason === "incompatible_handoff" || status.requiresQuiescence) &&
      (attempt.phase === "staging" || attempt.phase === "settling") &&
      !attempt.drain
    ) {
      const hold = await this.options.holds.begin(runnerId, attempt.id, {
        boundMs: DRAIN_HOLD_BOUND_MS,
        draining: true,
      });
      const retainedIds = [
        ...new Set(status.retained?.map((host) => host.sessionId)),
      ];
      const waiting: Attempt = {
        ...attempt,
        phase: "draining",
        retained: undefined,
        deadline: Date.parse(hold.beganAt) + DRAIN_WAIT_MS,
        drain: { retainedIds, agents: [] },
      };
      if (!(await this.step(runnerId, attempt, waiting))) return;
      return this.advance(runnerId);
    }
    if (
      attempt.phase === "draining" &&
      status.phase === "deferred" &&
      status.reason === "incompatible_handoff"
    )
      return;
    // The runner's reason wins, unless it only echoes Dispatch's own cancel.
    const reason =
      attempt.reason &&
      (!status.reason ||
        status.reason === "cancelled" ||
        status.reason === "reattach_failed")
        ? attempt.reason
        : (status.reason ?? "cancelled");
    return this.finish(runnerId, attempt, {
      state: status.phase === "rolled_back" ? "rolled_back" : "deferred",
      reason,
      ...(status.floorVersion && { floorVersion: status.floorVersion }),
    });
  }

  private async progressed(
    runnerId: string,
    attempt: Attempt,
    advert: SelfUpdateAdvert,
    epoch: number,
    status: RunnerUpdateEvent["status"]
  ): Promise<void> {
    const { phase, target } = attempt;
    if (phase === "cancelling" || phase === "draining" || !target) return;
    const { service } = this.options;

    if (status.phase === "activating") {
      if (phase !== "switching" && phase !== "confirming")
        return this.cancel(runnerId, attempt, "interrupted");
      if (status.reason !== "trial") return;
      const isTarget = (build: {
        version: string;
        revision: string;
        sha256: string;
      }) =>
        build.version === target.version &&
        build.revision === target.revision &&
        build.sha256 === target.sha256;
      if (
        !isTarget(status.installed) ||
        !isTarget({ ...advert, sha256: advert.installedSha256 }) ||
        !sameSessions(status.retained, attempt.retained)
      )
        return this.cancel(runnerId, attempt, "identity_mismatch");
      if (phase === "switching")
        await this.record(runnerId, {
          ...attempt,
          phase: "confirming",
          confirmBy: this.now() + UPDATE_TIMING.confirmingMs,
        });
      this.trials.set(runnerId, epoch);
      return this.advance(runnerId);
    }

    switch (status.reason) {
      case "ready": {
        if (attempt.retained) return;
        if (phase === "staging") {
          const settling: Attempt = {
            ...attempt,
            phase: "settling",
            deadline: this.now() + UPDATE_TIMING.settlingMs,
          };
          if (!(await this.step(runnerId, attempt, settling))) return;
        } else if (phase !== "settling") return;
        // Staged: work waits from here, before anything can be refused.
        if (!(await this.holdOrCancel(runnerId, attempt))) return;
        this.send(runnerId, () =>
          service.fenceUpdate(runnerId, attempt.id, !attempt.drain, epoch)
        );
        return;
      }
      case "fence_ready": {
        if (phase === "switching") {
          if (!sameSessions(status.retained, attempt.retained))
            return this.cancel(runnerId, attempt, "identity_mismatch");
          this.send(runnerId, () =>
            service.activateUpdate(runnerId, attempt.id, epoch)
          );
          return;
        }
        if (phase !== "settling") return;
        if (!status.retained || (attempt.drain && status.retained.length))
          return this.cancel(runnerId, attempt, "interrupted");
        const fenced: Attempt = {
          ...attempt,
          retained: status.retained,
          deadline: Math.min(
            attempt.deadline,
            this.now() + UPDATE_TIMING.attachMs
          ),
        };
        if (!(await this.step(runnerId, attempt, fenced))) return;
        return this.advance(runnerId);
      }
    }
  }

  // --- Evidence and deadlines ---

  private async advance(runnerId: string): Promise<void> {
    const attempt = this.active(runnerId);
    if (!attempt) return;
    const { service } = this.options;
    if (attempt.phase === "resuming")
      return this.resumeDrain(runnerId, attempt);
    if (!service.isRegistered(runnerId))
      return this.finish(runnerId, attempt, {
        state: "deferred",
        reason: "revoked",
      });
    const now = this.now();
    const live = service.selfUpdate(runnerId);
    const { phase } = attempt;
    if (phase === "draining") {
      if (
        now >= attempt.deadline ||
        this.options.holds.current(runnerId)?.attemptId !== attempt.id
      )
        return this.finish(runnerId, attempt, {
          state: "deferred",
          reason: "drain_timeout",
        });
      if (live) await this.drain(runnerId, attempt, live.advert, live.epoch);
      return;
    }
    if (now >= attempt.deadline) {
      if (phase === "cancelling" || !live)
        return this.finish(runnerId, attempt, {
          state: "deferred",
          reason:
            attempt.activated || !attempt.reason
              ? "no_response"
              : attempt.reason,
        });
      return this.cancel(runnerId, attempt, timeoutReason(attempt));
    }
    if (!live) return;
    const { epoch } = live;

    if (phase === "settling" && attempt.retained) {
      if (!this.allAttached(runnerId, attempt.retained, epoch)) return;
      const switching: Attempt = {
        ...attempt,
        phase: "switching",
        activated: true,
        deadline: now + UPDATE_TIMING.switchingMs,
      };
      if (!(await this.step(runnerId, attempt, switching))) return;
      this.send(runnerId, () =>
        service.activateUpdate(runnerId, attempt.id, epoch)
      );
      return;
    }
    if (phase !== "confirming") return;
    if (attempt.confirmBy !== undefined && now >= attempt.confirmBy)
      return this.cancel(
        runnerId,
        attempt,
        this.confirms.has(runnerId) ? "confirm_timeout" : "reattach_failed"
      );
    if (this.trials.get(runnerId) !== epoch) return;
    if (!this.allAttached(runnerId, attempt.retained!, epoch)) return;
    const last = this.confirms.get(runnerId);
    if (last !== undefined && now - last < UPDATE_TIMING.confirmRetryMs) return;
    this.confirms.set(runnerId, now);
    const { revision, sha256 } = attempt.target!;
    this.send(runnerId, () =>
      service.confirmUpdate(runnerId, attempt.id, { revision, sha256 }, epoch)
    );
  }

  private async drain(
    runnerId: string,
    attempt: Attempt,
    advert: SelfUpdateAdvert,
    epoch: number
  ) {
    const { agents } = this.options;
    const drain = attempt.drain!;
    const mayStop = () =>
      !this.closed &&
      !this.drainCancellations.has(attempt.id) &&
      this.now() < attempt.deadline &&
      this.options.service.connectionEpoch(runnerId) === epoch &&
      this.options.holds.current(runnerId)?.attemptId === attempt.id;
    const hosts = await agents.runnerDrainHosts(runnerId, drain.retainedIds);
    if (!mayStop()) return;
    const waiting = new Set(hosts.map(({ id }) => id)).size;
    this.waiting.set(runnerId, waiting);
    if (waiting !== drain.waiting) {
      attempt = { ...attempt, drain: { ...drain, waiting } };
      await this.save({ ...this.records.get(runnerId), runnerId, attempt });
      if (!mayStop()) return;
    }
    if (!hosts.length) {
      const next: Attempt = {
        ...attempt,
        phase: "settling",
        deadline: this.now() + UPDATE_TIMING.settlingMs,
      };
      if (await this.step(runnerId, attempt, next))
        this.sendOffer(runnerId, next, advert, epoch);
      return;
    }
    for (const { id, host } of hosts) {
      if (!mayStop()) return;
      if (host?.attachedEpoch !== epoch) {
        this.attach(runnerId, id);
        continue;
      }
      await agents.stopRunnerHostForDrain(
        runnerId,
        host,
        epoch,
        mayStop,
        async (entry) => {
          const current = this.active(runnerId)!;
          const drain = current.drain!;
          const next = {
            ...current,
            drain: {
              ...drain,
              agents: [
                ...drain.agents.filter(({ id }) => id !== entry.id),
                entry,
              ],
            },
          };
          // A failed write must never allow the host to shut down.
          await this.save({
            ...this.records.get(runnerId),
            runnerId,
            attempt: next,
          });
        }
      );
    }
  }

  private async resumeDrain(runnerId: string, attempt: Attempt) {
    const drain = attempt.drain!;
    const { agents, service } = this.options;
    if (drain.agents.length && service.isRegistered(runnerId)) {
      // A reconnect with an outstanding trial is not an installed build yet.
      const live = service.selfUpdate(runnerId);
      if (
        service.connectionEpoch(runnerId) === undefined ||
        live?.advert.pendingAttemptId
      )
        return;
      const [entry, ...remaining] = drain.agents;
      await agents.resumeRunnerDrainHost(runnerId, attempt.id, entry!);
      const next = { ...attempt, drain: { ...drain, agents: remaining } };
      await this.save({
        ...this.records.get(runnerId),
        runnerId,
        attempt: next,
      });
      if (remaining.length) return;
      attempt = next;
    }
    return this.finish(runnerId, attempt, drain.result!);
  }

  /**
   * Proof is the host's own welcome and completed replay, for the recorded
   * instance, on an attach opened over this connection. A connected runner
   * or an open socket proves nothing.
   */
  private allAttached(
    runnerId: string,
    retained: RetainedSession[],
    epoch: number
  ): boolean {
    const { agents } = this.options;
    const missing = retained.filter(
      (session) => !agents.isRunnerSessionAttached(runnerId, session, epoch)
    );
    for (const { sessionId } of missing) this.attach(runnerId, sessionId);
    return missing.length === 0;
  }

  private attach(runnerId: string, sessionId: string) {
    const key = `${runnerId}/${sessionId}`;
    if (this.attaching.has(key)) return;
    this.attaching.add(key);
    void this.options.agents
      .attachRunnerSession(runnerId, sessionId)
      .catch((err: unknown) =>
        this.options.logger.warn(
          { err, runnerId, sessionId },
          "could not attach a retained runner session"
        )
      )
      .finally(() => this.attaching.delete(key));
  }

  // --- Ending an attempt ---

  private cancelling(attempt: Attempt, reason: string): Attempt {
    return {
      ...attempt,
      phase: "cancelling",
      reason,
      deadline: attempt.activated
        ? Math.max(attempt.deadline, this.now() + UPDATE_TIMING.rollbackMs)
        : this.now() + UPDATE_TIMING.cancelMs,
    };
  }

  /** Ends on the runner's answer, so the hold outlasts the fence. */
  private async cancel(runnerId: string, attempt: Attempt, reason: string) {
    const next = this.cancelling(attempt, reason);
    await this.record(runnerId, next);
    const epoch = this.options.service.connectionEpoch(runnerId);
    if (epoch !== undefined) this.sendCancel(runnerId, next, epoch);
  }

  private async finish(runnerId: string, attempt: Attempt, outcome: Outcome) {
    if (attempt.drain?.agents.length && attempt.phase !== "resuming") {
      await this.record(runnerId, {
        ...attempt,
        phase: "resuming",
        drain: { ...attempt.drain, result: outcome },
      });
      return;
    }
    this.waiting.delete(runnerId);
    const { target } = attempt;
    let { confirmed, failed } = this.records.get(runnerId) ?? {};
    if (outcome.state === "updated" && target) {
      confirmed = {
        attemptId: attempt.id,
        revision: target.revision,
        sha256: target.sha256,
      };
      failed = undefined;
    } else if (
      target &&
      (outcome.state === "rolled_back" || outcome.reason === "suppressed")
    ) {
      failed = { version: target.version, revision: target.revision };
    }
    await this.saveOrKeep({
      runnerId,
      attempt: { ...attempt, drain: undefined, outcome },
      ...(confirmed && { confirmed }),
      ...(failed && { failed }),
    });
    this.forgetTrial(runnerId);
    this.options.logger.info(
      { runnerId, attemptId: attempt.id, outcome },
      "runner update ended"
    );
    this.release(runnerId, attempt.id, holdOutcome(outcome));
    this.resumeRecycling(runnerId);
  }

  /**
   * The gate opens synchronously. Resuming held launches can take minutes,
   * so this runner's queue does not wait for them.
   */
  private release(
    runnerId: string,
    attemptId: string,
    outcome: RunnerHoldOutcome
  ) {
    this.options.holds
      .release(runnerId, attemptId, outcome)
      .catch((error: unknown) =>
        this.options.logger.error(
          { err: error, runnerId, attemptId },
          "could not release the runner update hold"
        )
      );
  }

  /** False when the hold could not be saved, which ends the attempt. */
  private async holdOrCancel(runnerId: string, attempt: Attempt) {
    try {
      await this.holdFor(runnerId, attempt.id);
      return true;
    } catch (error) {
      this.options.logger.error(
        { err: error, runnerId },
        "could not hold the runner for its update"
      );
      await this.cancel(runnerId, attempt, "state_unsaved");
      return false;
    }
  }

  private async holdFor(runnerId: string, attemptId: string) {
    this.releaseOther(runnerId, attemptId);
    if (this.active(runnerId)?.drain) {
      if (this.options.holds.current(runnerId)?.attemptId !== attemptId)
        throw new Error("The drain hold expired.");
      return;
    }
    await this.options.holds.begin(runnerId, attemptId, {
      boundMs: UPDATE_HOLD_BOUND_MS,
    });
  }

  private releaseOther(runnerId: string, attemptId: string) {
    const other = this.options.holds.current(runnerId);
    if (other && other.attemptId !== attemptId)
      this.release(runnerId, other.attemptId, "fence_released");
  }

  /** Move hosts to the last confirmed build while the runner still runs it. */
  private resumeRecycling(runnerId: string) {
    if (this.active(runnerId) || this.opening.has(runnerId)) return;
    const { service, agents } = this.options;
    const confirmed = this.records.get(runnerId)?.confirmed;
    const advert = service.selfUpdate(runnerId)?.advert;
    if (!confirmed || !advert) return;
    if (
      advert.revision === confirmed.revision &&
      advert.installedSha256 === confirmed.sha256
    )
      agents.startRunnerHostRecycling({ runnerId, ...confirmed });
    else agents.stopRunnerHostRecycling(runnerId);
  }

  // --- Frames ---

  private sendOffer(
    runnerId: string,
    attempt: Attempt,
    advert: SelfUpdateAdvert,
    epoch: number
  ) {
    const { service } = this.options;
    // A cancel is the only thing that clears an unreadable fence. Its
    // `fenceCleared` answer brings the offer back here.
    if (advert.fenceUnreadable) this.sendCancel(runnerId, attempt, epoch);
    else
      this.send(runnerId, () =>
        service.offerUpdate(
          runnerId,
          attempt.id,
          attempt.target!,
          attempt.retry,
          epoch
        )
      );
  }

  private sendCancel(runnerId: string, attempt: Attempt, epoch: number) {
    this.send(runnerId, () =>
      this.options.service.cancelUpdate(
        runnerId,
        attempt.id,
        cancelReason(attempt.reason),
        epoch
      )
    );
  }

  private send(runnerId: string, frame: () => unknown) {
    try {
      frame();
    } catch (error) {
      // The connection changed; the next one resumes from the saved phase.
      this.options.logger.warn(
        { err: error, runnerId },
        "runner update frame was not sent"
      );
    }
  }

  // --- State ---

  private active(runnerId: string): Attempt | undefined {
    const attempt = this.records.get(runnerId)?.attempt;
    return attempt && !attempt.outcome ? attempt : undefined;
  }

  private forgetTrial(runnerId: string) {
    this.trials.delete(runnerId);
    this.confirms.delete(runnerId);
  }

  private isOwnBuild(
    target: { version: string; revision: string } | undefined
  ) {
    const { version, revision } = this.options.build;
    return target?.version === version && target.revision === revision;
  }

  private suppressed(runnerId: string) {
    const failed = this.records.get(runnerId)?.failed;
    const { version, revision } = this.options.build;
    return failed?.version === version && failed.revision === revision;
  }

  private showsResult(
    attempt: Attempt,
    outcome: Outcome,
    advert: SelfUpdateAdvert | undefined
  ) {
    const { target } = attempt;
    if (outcome.state === "updated")
      return !advert || !target || advert.installedSha256 === target.sha256;
    // A failure is history once the runner has this build anyway.
    if (advert && this.isOwnBuild(advert)) return false;
    return (
      !target ||
      this.isOwnBuild(target) ||
      outcome.reason === "dispatch_changed"
    );
  }

  /** Save the step before its frame is sent; a failed save ends the attempt. */
  private async step(runnerId: string, from: Attempt, to: Attempt) {
    try {
      await this.save({ ...this.records.get(runnerId), runnerId, attempt: to });
      return true;
    } catch (error) {
      this.options.logger.error(
        { err: error, runnerId },
        "could not save a runner update step"
      );
      await this.cancel(runnerId, from, "state_unsaved");
      return false;
    }
  }

  private record(runnerId: string, attempt: Attempt) {
    return this.saveOrKeep({
      ...this.records.get(runnerId),
      runnerId,
      attempt,
    });
  }

  /** For steps that must happen even if they cannot be saved. */
  private async saveOrKeep(record: RunnerUpdateRecord) {
    try {
      await this.save(record);
    } catch (error) {
      this.options.logger.error(
        { err: error, runnerId: record.runnerId },
        "could not save runner update state"
      );
      this.records.set(record.runnerId, record);
      this.syncReceipt(record);
    }
  }

  private syncReceipt({ runnerId, attempt }: RunnerUpdateRecord) {
    if (attempt.drain)
      this.options.agents.setRunnerDrainReceipt(
        runnerId,
        attempt.drain.agents.map(({ id }) => id)
      );
  }

  /** Writes are serialized, and memory follows the file. */
  private save(record: RunnerUpdateRecord): Promise<void> {
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const next = new Map(this.records).set(record.runnerId, record);
        await this.options.store.write([...next.values()]);
        const hadDrain = this.records.get(record.runnerId)?.attempt.drain;
        this.records.set(record.runnerId, record);
        if (hadDrain && !record.attempt.drain)
          this.options.agents.setRunnerDrainReceipt(record.runnerId, []);
        this.syncReceipt(record);
      });
    this.writes = write;
    return write;
  }

  private enqueue<Result>(
    runnerId: string,
    work: () => Promise<Result>
  ): Promise<Result> {
    const run = (this.queues.get(runnerId) ?? this.whenStarted)
      .catch(() => {})
      .then(() => {
        if (this.closed) throw new RunnerUpdateIneligible("not_ready");
        return work();
      });
    this.queues.set(runnerId, run);
    return run;
  }

  private background(runnerId: string, work: () => Promise<void>) {
    const guarded = () =>
      work().catch((error: unknown) =>
        this.options.logger.error(
          { err: error, runnerId },
          "runner update reconciliation failed"
        )
      );
    // Rejected only once closed.
    this.enqueue(runnerId, guarded).catch(() => {});
  }
}

function holdOutcome({ state }: Outcome): RunnerHoldOutcome {
  if (state === "updated") return "committed";
  return state === "rolled_back" ? "rolled_back" : "cancelled";
}

function timeoutReason({ phase, retained }: Attempt) {
  if (phase === "staging") return "staging_timeout";
  if (phase === "settling")
    return retained ? "attach_unavailable" : "settle_timeout";
  return phase === "switching" ? "switch_timeout" : "confirm_timeout";
}

function cancelReason(reason: string | undefined): RunnerUpdateCancelReason {
  switch (reason) {
    case "settle_timeout":
      return "quiesce_timeout";
    case "identity_mismatch":
    case "reattach_failed":
    case "confirm_timeout":
    case "switch_timeout":
      return "trial_failed";
    default:
      return "policy_changed";
  }
}

/** Undefined when either version cannot be ordered: never an upgrade. */
function versionOrder(left: string, right: string) {
  try {
    return Math.sign(compareRunnerVersions(left, right));
  } catch {
    return undefined;
  }
}

function sameSessions(
  left: RetainedSession[] | undefined,
  right: RetainedSession[] | undefined
) {
  if (!left || !right || left.length !== right.length) return false;
  const key = (session: RetainedSession) =>
    `${session.sessionId}/${session.instanceId}`;
  const expected = new Set(right.map(key));
  return left.every((session) => expected.has(key(session)));
}
