import type { FastifyRequest } from "fastify";
import {
  RECOVERY_ROUTE_PREFIX,
  RECOVERY_EXIT_CODE,
  MAX_LEASE_MS,
  safeEqual,
  type ProbationConfig,
} from "./protocol.js";
import type { DatabaseProbe } from "./database-probe.js";
import { sameVersion } from "./control.js";
const DEFAULT_LEASE_MS = 120_000;
const DRAIN_TIMEOUT_MS = 10_000;
export type RecoveryMode = "normal" | "fenced" | "probation";

export type BusyReason = {
  kind:
    | "agent-turn"
    | "agent-transition"
    | "chat-delivery"
    | "job-run"
    | "release-job"
    | "archive"
    | "host-busy"
    | "host-unattached"
    | "host-still-running"
    | "resume-receipt";
  agentId?: string;
  detail?: string;
};

export type RecoveryBoundary = {
  hostsStopped: boolean;
  liveHosts: string[];
  statePaths: string[];
  macBuild: string | null;
};

export type MaintenanceDeps = {
  version: string;
  /** Intrinsic identity the helper can check (state dir, port, Mac id). */
  instance: {
    instanceId: string | null;
    stateDir: string;
    port: number;
    macInstanceId: string | null;
  };
  /** Authoritative activity owners; any reason defers the fence. */
  busyReasons: () => Promise<BusyReason[]>;
  /** One-way: stop schedulers, loops and other autonomous writers. */
  stopWriters: () => Promise<void>;
  /**
   * One-way: stop idle agent hosts, which outlive a service stop and would
   * keep writing during the backup. Returns hosts that are still running.
   */
  quiesceHosts: (transactionId: string) => Promise<BusyReason[]>;
  /** Bounded DB identity and write probe inside a rolled-back transaction. */
  probeDatabase: () => Promise<DatabaseProbe>;
  /**
   * Evidence for the backup boundary, read fresh for each signed answer:
   * live agent hosts (by pid), Dispatch-owned durable paths, Mac build.
   */
  boundary: () => Promise<RecoveryBoundary>;
  /** Graceful exit with a nonzero code so the supervisor restarts normally. */
  exit: (code: number) => void;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  now?: () => number;
  drainTimeoutMs?: number;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROBATION_OPEN = new Set([
  "/api/v1/health",
  "/api/v1/app/branding",
  "/ping",
]);

export type Admission = { status: 503; code: "MAINTENANCE" | "PROBATION" };

/**
 * The in-process half of the protocol. `admit` is synchronous so a request
 * arriving after `fence` starts can never slip past the gate.
 */
export class RecoveryMaintenance {
  private state: RecoveryMode;
  private gateClosed: boolean;
  private transactionId: string | null;
  private fencing: Promise<FenceResult> | null = null;
  private fencedAt: number | null = null;
  private leaseExpiresAt: number | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private exiting = false;
  private inFlight = new Set<object>();
  private drainWaiters: Array<() => void> = [];
  private probationConfig: ProbationConfig | null;
  private probationReady = false;

  constructor(
    private readonly deps: MaintenanceDeps,
    probation: ProbationConfig | null = null
  ) {
    this.probationConfig = probation;
    this.state = probation ? "probation" : "normal";
    this.gateClosed = probation !== null;
    this.transactionId = probation?.transactionId ?? null;
    if (probation) this.armProbationDeadline();
  }

  /** Called before database initialization or admission; never releases a fence. */
  enterProbation(value: ProbationConfig): void {
    if (this.state !== "normal" || this.inFlight.size !== 0 || this.gateClosed)
      throw new Error("Recovery probation must precede normal work");
    this.probationConfig = value;
    this.state = "probation";
    this.gateClosed = true;
    this.transactionId = value.transactionId;
    this.armProbationDeadline();
  }

  private armProbationDeadline(): void {
    // Even a lost helper must drive the service back through its startup gate.
    this.leaseTimer = setTimeout(
      () => this.restart("probation lifetime expired"),
      300_000
    );
    this.leaseTimer.unref?.();
  }

  get probation(): ProbationConfig | null {
    return this.probationConfig;
  }

  get mode(): RecoveryMode {
    return this.state;
  }

  boundary(): Promise<RecoveryBoundary> {
    return this.deps.boundary();
  }

  identity(): Record<string, unknown> {
    return {
      version: this.deps.version,
      instance: this.deps.instance,
      pid: process.pid,
    };
  }

  /** Probation startup finished migrations and route registration. */
  markProbationReady(): void {
    this.probationReady = true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Decide a request's admission. Recovery routes are always admitted;
   * probation admits only health/branding (static assets are not /api).
   */
  admit(request: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
  }): Admission | null {
    const url = request.url.split("?")[0];
    if (url.startsWith(RECOVERY_ROUTE_PREFIX)) return null;
    if (!url.startsWith("/api/") && !request.headers.upgrade) return null;
    if (this.state === "probation") {
      if (PROBATION_OPEN.has(url) && request.method === "GET") return null;
      return { status: 503, code: "PROBATION" };
    }
    if (!this.gateClosed) return null;
    if (SAFE_METHODS.has(request.method) && !request.headers.upgrade)
      return null;
    return { status: 503, code: "MAINTENANCE" };
  }

  /** Track an admitted mutating request so a fence can drain it. */
  requestStarted(request: object, method: string): void {
    if (!SAFE_METHODS.has(method)) this.inFlight.add(request);
  }

  requestFinished(request: object): void {
    if (!this.inFlight.delete(request)) return;
    if (this.inFlight.size === 0) {
      for (const resolve of this.drainWaiters.splice(0)) resolve();
    }
  }

  private async drain(): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    const timeoutMs = this.deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      new Promise<boolean>((resolve) =>
        this.drainWaiters.push(() => resolve(true))
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return drained;
  }

  status(): Record<string, unknown> {
    return {
      mode: this.state,
      transactionId: this.transactionId,
      fencedAt: this.fencedAt ? new Date(this.fencedAt).toISOString() : null,
      leaseExpiresAt: this.leaseExpiresAt
        ? new Date(this.leaseExpiresAt).toISOString()
        : null,
      probationReady: this.state === "probation" ? this.probationReady : null,
    };
  }

  async fence(input: {
    transactionId: string;
    leaseMs?: number;
  }): Promise<FenceResult> {
    if (this.state === "probation")
      return { ok: false, status: 409, code: "IN_PROBATION" };
    if (this.exiting) return { ok: false, status: 409, code: "EXITING" };
    if (this.transactionId && this.transactionId !== input.transactionId)
      return { ok: false, status: 409, code: "FENCED_BY_OTHER" };
    if (this.state === "fenced") return { ok: true };
    if (this.fencing) return this.fencing;
    this.transactionId = input.transactionId;
    this.gateClosed = true;
    this.fencing = this.runFence(input.leaseMs ?? DEFAULT_LEASE_MS).finally(
      () => {
        this.fencing = null;
      }
    );
    return this.fencing;
  }

  private reopen(): void {
    this.gateClosed = false;
    this.transactionId = null;
  }

  private async runFence(leaseMs: number): Promise<FenceResult> {
    try {
      if (!(await this.drain())) {
        this.reopen();
        return { ok: false, status: 409, code: "DRAIN_TIMEOUT" };
      }
      const before = await this.deps.busyReasons();
      if (before.length > 0) {
        this.reopen();
        return { ok: false, status: 409, code: "BUSY", reasons: before };
      }
      // Past this point the fence is one-way: schedulers cannot be resumed
      // in-process, so any later failure ends in a supervisor restart.
      await this.deps.stopWriters();
      const after = await this.deps.busyReasons();
      if (after.length > 0 || this.inFlight.size > 0) {
        this.restart("busy after fence");
        return {
          ok: false,
          status: 409,
          code: "BUSY_AFTER_FENCE",
          reasons: after,
        };
      }
      const hosts = await this.deps.quiesceHosts(this.transactionId!);
      if (hosts.length > 0) {
        this.restart("agent hosts not quiesced");
        return {
          ok: false,
          status: 409,
          code: "HOSTS_NOT_QUIESCED",
          reasons: hosts,
        };
      }
      this.state = "fenced";
      this.fencedAt = this.now();
      this.leaseExpiresAt = this.fencedAt + leaseMs;
      this.leaseTimer = setTimeout(
        () => this.restart("fence lease expired"),
        leaseMs
      );
      this.leaseTimer.unref?.();
      this.deps.log.info(
        { transactionId: this.transactionId, leaseMs },
        "Update recovery fence acquired"
      );
      return { ok: true };
    } catch (error) {
      this.deps.log.warn({ err: error }, "Update recovery fence failed");
      if (this.gateClosed && this.state === "normal") {
        // Unknown how far stopWriters got: restart rather than reopen.
        this.restart("fence failed");
      }
      return { ok: false, status: 500, code: "FENCE_FAILED" };
    }
  }

  /** Abort a fence held by `transactionId`; the supervisor restarts us. */
  abort(transactionId: string): FenceResult {
    if (
      (!this.fencing && this.state !== "fenced") ||
      this.transactionId !== transactionId
    )
      return { ok: false, status: 409, code: "NOT_FENCED" };
    this.restart("fence aborted by helper");
    return { ok: true };
  }

  private restart(reason: string): void {
    if (this.exiting) return;
    this.exiting = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.deps.log.warn(
      { transactionId: this.transactionId, reason },
      "Update recovery restarting server"
    );
    this.deps.exit(RECOVERY_EXIT_CODE);
  }

  async readiness(input: {
    transactionId: string;
    nonce: string;
    instanceId: string;
    expectedVersion: string;
  }): Promise<
    | {
        ok: true;
        body: Record<string, unknown>;
        secret: Record<string, string>;
      }
    | { ok: false; status: number; code: string; liveHosts?: string[] }
  > {
    const probation = this.probation;
    if (!probation) return { ok: false, status: 409, code: "NOT_IN_PROBATION" };
    if (
      input.transactionId !== probation.transactionId ||
      !safeEqual(input.nonce, probation.nonce)
    )
      return { ok: false, status: 409, code: "TRANSACTION_MISMATCH" };
    if (input.instanceId !== probation.instanceId)
      return { ok: false, status: 409, code: "INSTANCE_MISMATCH" };
    if (
      (probation.expectedVersion !== undefined &&
        !sameVersion(input.expectedVersion, probation.expectedVersion)) ||
      !sameVersion(input.expectedVersion, this.deps.version)
    )
      return { ok: false, status: 409, code: "VERSION_MISMATCH" };
    if (!this.probationReady)
      return { ok: false, status: 503, code: "STARTING" };
    const started = this.now();
    let database: DatabaseProbe;
    try {
      database = await this.deps.probeDatabase();
    } catch (error) {
      this.deps.log.warn({ err: error }, "Recovery readiness probe failed");
      return { ok: false, status: 503, code: "DATABASE_PROBE_FAILED" };
    }
    // Probation never attaches hosts, so a live one is outside the boundary.
    const boundary = await this.deps.boundary();
    if (!boundary.hostsStopped)
      return {
        ok: false,
        status: 409,
        code: "HOSTS_RUNNING",
        liveHosts: boundary.liveHosts,
      };
    return {
      ok: true,
      body: {
        ...boundary,
        ready: true,
        transactionId: probation.transactionId,
        instanceId: probation.instanceId,
        version: this.deps.version,
        instance: this.deps.instance,
        pid: process.pid,
        database,
        probeMs: this.now() - started,
      },
      secret: { nonce: probation.nonce },
    };
  }
}

export type FenceResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      reasons?: BusyReason[];
    };
