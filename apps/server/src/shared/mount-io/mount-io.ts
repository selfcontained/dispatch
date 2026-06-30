import { CircuitBreaker } from "./circuit-breaker.js";
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

export type MountIOConfig = {
  timeoutMs: number;
  maxConcurrency: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  now?: () => number;
};

export class MountIO {
  private readonly sem: Semaphore;
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;

  constructor(cfg: MountIOConfig) {
    this.sem = new Semaphore(cfg.maxConcurrency);
    this.breaker = new CircuitBreaker(
      cfg.breakerThreshold,
      cfg.breakerCooldownMs,
      cfg.now,
    );
    this.timeoutMs = cfg.timeoutMs;
  }

  available(): boolean {
    return this.breaker.canProceed();
  }

  async run<T>(
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.breaker.canProceed()) {
      throw new MountUnavailableError(label);
    }

    await this.sem.acquire();
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const work = fn(ac.signal);
      work.catch(() => {});

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort(new MountStallError(label, this.timeoutMs));
          reject(new MountStallError(label, this.timeoutMs));
        }, this.timeoutMs);
      });

      const result = await Promise.race([work, timeout]);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      if (err instanceof MountStallError) {
        this.breaker.recordFailure();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.sem.release();
    }
  }

  reset(): void {
    this.breaker.reset();
  }
}
