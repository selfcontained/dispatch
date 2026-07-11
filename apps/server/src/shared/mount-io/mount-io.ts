import { CircuitBreaker, type BreakerState } from "./circuit-breaker.js";
import { Semaphore } from "./semaphore.js";

export class MountStallError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`mount op "${label}" exceeded ${timeoutMs}ms`);
    this.name = "MountStallError";
  }
}

export class MountUnavailableError extends Error {
  constructor(label: string) {
    super(`mount unavailable (circuit open), skipped "${label}"`);
    this.name = "MountUnavailableError";
  }
}

/** Minimal structural logger (satisfied by pino / FastifyBaseLogger). */
export type MountIOLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
};

export type MountIOConfig = {
  timeoutMs: number;
  maxConcurrency: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  now?: () => number;
  logger?: MountIOLogger;
};

export class MountIO {
  private readonly sem: Semaphore;
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly breakerCooldownMs: number;
  private logger?: MountIOLogger;

  constructor(cfg: MountIOConfig) {
    this.sem = new Semaphore(cfg.maxConcurrency);
    this.breaker = new CircuitBreaker(
      cfg.breakerThreshold,
      cfg.breakerCooldownMs,
      cfg.now
    );
    this.timeoutMs = cfg.timeoutMs;
    this.breakerCooldownMs = cfg.breakerCooldownMs;
    this.logger = cfg.logger;
  }

  /**
   * Attach a logger after construction (the process-wide singleton is built at
   * import time, before the app logger exists).
   */
  setLogger(logger: MountIOLogger): void {
    this.logger = logger;
  }

  available(): boolean {
    return this.breaker.canProceed();
  }

  /**
   * Run a single filesystem operation against the (possibly stalled) mount,
   * guarded by a circuit breaker, a bounded-concurrency semaphore, and a
   * timeout.
   *
   * IMPORTANT — the timeout *abandons*, it does not *cancel*. When the timeout
   * fires we abort the signal, release the semaphore permit, and reject the
   * caller with a `MountStallError`. But the underlying syscall keeps running
   * on its libuv/Bun I/O thread until the kernel/gcsfuse unblocks it (which on
   * a hard mount wedge may be never). Consequences callers must understand:
   *
   *   1. `fn` MUST honor the supplied `AbortSignal` (e.g. pass it to
   *      `createReadStream({ signal })`). A `fn` that ignores the signal turns
   *      every timeout into a *leaked* background op holding an I/O-pool
   *      thread. With enough leaks the pool is exhausted and ALL threadpool
   *      work server-wide (fs, dns, crypto, zlib) stalls — the exact failure
   *      this guard exists to prevent. Where the underlying API genuinely
   *      cannot take a signal (e.g. `fs.readdir`), the op is bounded only by
   *      the caller-side timeout and the residual leak risk is real — keep
   *      `maxConcurrency` and `breakerThreshold` low and raise
   *      `UV_THREADPOOL_SIZE` for the server process so a few wedged threads
   *      cannot starve the pool.
   *   2. `available()` and the semaphore track JS-tracked ops, not in-flight
   *      kernel work. A released permit lets a new op dispatch even though the
   *      abandoned syscall's thread is still stuck.
   *
   * `fn` receives a `heartbeat()` callback. The timeout starts as a
   * whole-operation deadline; each `heartbeat()` call re-arms it, turning it
   * into an *idle* (no-progress) deadline. Streaming readers should call
   * `heartbeat()` per chunk/line so a slow-but-progressing read over a healthy
   * mount is not mistaken for a stall — only a genuine no-data stall trips the
   * breaker. Single-shot ops (e.g. readdir) simply never heartbeat and keep
   * the whole-operation deadline.
   */
  async run<T>(
    label: string,
    fn: (signal: AbortSignal, heartbeat: () => void) => Promise<T>
  ): Promise<T> {
    if (!this.breaker.canProceed()) {
      throw new MountUnavailableError(label);
    }

    await this.sem.acquire();
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    try {
      let rejectTimeout!: (err: Error) => void;
      const timeout = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });

      // (Re)arm the deadline. Called once up front (whole-op deadline) and
      // again on every heartbeat (turning it into an idle deadline).
      const arm = (): void => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const err = new MountStallError(label, this.timeoutMs);
          ac.abort(err);
          rejectTimeout(err);
        }, this.timeoutMs);
      };
      arm();

      const work = fn(ac.signal, arm);
      // Load-bearing: when the timeout wins the race, `work` has no other
      // rejection handler and rejects later (once the abandoned op settles via
      // abort). Without this no-op catch that becomes an unhandledRejection,
      // which under Node's default policy can terminate the process. Do not
      // remove.
      work.catch(() => {});

      const result = await Promise.race([work, timeout]);
      this.recordSuccess();
      return result;
    } catch (err) {
      // Only a genuine stall trips the breaker. Per-file errors (ENOENT, parse
      // failures, permission errors) are intentionally neutral — a single bad
      // or absent session file must never open the process-wide circuit and
      // suppress harvesting for every agent. Do not broaden this to all errors.
      if (err instanceof MountStallError) {
        this.recordFailure();
      }
      throw err;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      this.sem.release();
    }
  }

  private recordSuccess(): void {
    const prev = this.breaker.state();
    this.breaker.recordSuccess();
    if (prev !== "closed") {
      this.logger?.info({}, "mount-io: mount recovered, harvesting resumed");
    }
  }

  private recordFailure(): void {
    const prev: BreakerState = this.breaker.state();
    this.breaker.recordFailure();
    if (prev !== "open" && this.breaker.state() === "open") {
      this.logger?.warn(
        { cooldownMs: this.breakerCooldownMs },
        "mount-io: breaker opened after mount stall, pausing harvest"
      );
    }
  }

  reset(): void {
    this.breaker.reset();
  }
}
