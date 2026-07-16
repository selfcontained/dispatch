export type SubsystemHealthState =
  | "healthy"
  | "degraded"
  | "running"
  | "idle"
  | "disabled"
  | "unknown";

export type SubsystemSnapshot = {
  id: string;
  label: string;
  description: string;
  state: SubsystemHealthState;
  statusReason: "failure" | "stale" | "stuck" | null;
  expectedCadenceMs: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastDurationMs: number | null;
  p95DurationMs: number | null;
  inFlight: number;
  runs: number;
  failures: number;
  lastError: string | null;
  metadata: Record<string, number>;
};

export type SubsystemRun = {
  succeed(metadata?: Record<string, number>): void;
  fail(error: unknown, metadata?: Record<string, number>): void;
};

export type SubsystemTrackerOptions = {
  id: string;
  label: string;
  description: string;
  expectedCadenceMs?: number | null;
};

const MAX_DURATIONS = 60;

function publicErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout|abort/i.test(raw)
    ? "Operation timed out"
    : "Operation failed";
}

export class SubsystemTracker {
  private readonly options: Required<SubsystemTrackerOptions>;
  private durations: number[] = [];
  private activeStarts: number[] = [];
  private inFlight = 0;
  private runs = 0;
  private failures = 0;
  private disabled = false;
  private lastStartedAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private lastSucceededAt: number | null = null;
  private lastFailedAt: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private metadata: Record<string, number> = {};

  constructor(options: SubsystemTrackerOptions) {
    this.options = {
      ...options,
      expectedCadenceMs: options.expectedCadenceMs ?? null,
    };
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  start(): SubsystemRun {
    const startedAt = Date.now();
    this.lastStartedAt = startedAt;
    this.activeStarts.push(startedAt);
    this.inFlight += 1;
    let completed = false;

    const finish = (
      succeeded: boolean,
      error: unknown,
      metadata?: Record<string, number>
    ) => {
      if (completed) return;
      completed = true;
      const completedAt = Date.now();
      const duration = Math.max(0, completedAt - startedAt);
      const activeIndex = this.activeStarts.indexOf(startedAt);
      if (activeIndex >= 0) this.activeStarts.splice(activeIndex, 1);
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.runs += 1;
      this.lastCompletedAt = completedAt;
      this.lastDurationMs = duration;
      this.durations.push(duration);
      if (this.durations.length > MAX_DURATIONS) {
        this.durations = this.durations.slice(-MAX_DURATIONS);
      }
      if (metadata) this.metadata = { ...metadata };

      if (succeeded) {
        this.lastSucceededAt = completedAt;
        this.lastError = null;
      } else {
        this.failures += 1;
        this.lastFailedAt = completedAt;
        this.lastError = publicErrorSummary(error);
      }
    };

    return {
      succeed: (metadata) => finish(true, null, metadata),
      fail: (error, metadata) => finish(false, error, metadata),
    };
  }

  snapshot(now = Date.now()): SubsystemSnapshot {
    let state: SubsystemHealthState;
    let statusReason: SubsystemSnapshot["statusReason"] = null;
    const oldestActiveStart =
      this.activeStarts.length > 0 ? Math.min(...this.activeStarts) : null;
    const activeRunIsStuck =
      this.options.expectedCadenceMs !== null &&
      oldestActiveStart !== null &&
      now - oldestActiveStart > this.options.expectedCadenceMs * 2;
    if (this.disabled) {
      state = "disabled";
    } else if (activeRunIsStuck) {
      state = "degraded";
      statusReason = "stuck";
    } else if (this.inFlight > 0) {
      state = "running";
    } else if (this.runs === 0) {
      state = this.options.expectedCadenceMs === null ? "idle" : "unknown";
    } else if (
      this.lastFailedAt !== null &&
      (this.lastSucceededAt === null ||
        this.lastFailedAt > this.lastSucceededAt)
    ) {
      state = "degraded";
      statusReason = "failure";
    } else if (
      this.options.expectedCadenceMs !== null &&
      this.lastSucceededAt !== null &&
      now - this.lastSucceededAt > this.options.expectedCadenceMs * 2
    ) {
      state = "degraded";
      statusReason = "stale";
    } else {
      state = "healthy";
    }

    const sorted = [...this.durations].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);

    return {
      id: this.options.id,
      label: this.options.label,
      description: this.options.description,
      state,
      statusReason,
      expectedCadenceMs: this.options.expectedCadenceMs,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastSucceededAt: this.lastSucceededAt,
      lastFailedAt: this.lastFailedAt,
      lastDurationMs: this.lastDurationMs,
      p95DurationMs: sorted.length > 0 ? sorted[p95Index] : null,
      inFlight: this.inFlight,
      runs: this.runs,
      failures: this.failures,
      lastError: this.lastError,
      metadata: { ...this.metadata },
    };
  }
}
