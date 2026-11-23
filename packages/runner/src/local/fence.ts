import { RunnerCallError } from "@dispatch/runner-protocol/contract";

/**
 * Operations a frozen runner still serves: they read and change nothing. A
 * `read` retry rule is not enough (`session.stop` is repeatable and writes),
 * so the list is explicit; anything not named is refused with `fenced`.
 */
export const SERVED_WHILE_FROZEN: ReadonlySet<string> = new Set([
  "runner.describe",
  "runner.health",
  "session.list",
]);

export const fencedError = () =>
  new RunnerCallError({
    code: "fenced",
    message: "The runner is frozen for an update",
  });

/**
 * The updater's write fence inside the runner. While frozen, admission
 * refuses every operation outside `SERVED_WHILE_FROZEN` before its handler
 * runs. `freeze` resolves only once the writes admitted before it have
 * finished, so its answer means nothing is writing.
 */
export class WriteFence {
  private frozenNow: boolean;
  private inFlight = 0;
  private idle: Array<() => void> = [];

  constructor(frozen = false) {
    this.frozenNow = frozen;
  }

  get frozen(): boolean {
    return this.frozenNow;
  }

  /**
   * Admit one operation. Returns its release (call when it has finished), or
   * null when it is refused because the runner is frozen.
   */
  enter(op: string): (() => void) | null {
    if (SERVED_WHILE_FROZEN.has(op)) return () => {};
    if (this.frozenNow) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) for (const done of this.idle.splice(0)) done();
    };
  }

  /** Refuse new writes now; resolve when none admitted earlier is running. */
  freeze(): Promise<void> {
    this.frozenNow = true;
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  thaw(): void {
    this.frozenNow = false;
  }
}
