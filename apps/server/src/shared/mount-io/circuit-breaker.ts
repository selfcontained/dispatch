export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  state(): BreakerState {
    if (this.openedAt === null) return "closed";
    if (this.now() - this.openedAt >= this.cooldownMs) return "half-open";
    return "open";
  }

  canProceed(): boolean {
    return this.state() !== "open";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    if (this.state() === "half-open") {
      this.openedAt = this.now();
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openedAt = this.now();
    }
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = null;
  }
}
