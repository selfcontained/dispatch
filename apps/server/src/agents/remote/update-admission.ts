import type { RetainedSession, RunnerUpdateTarget } from "./protocol.js";

/*
 * The supervisor's process admission gate for a self-update. While the gate
 * is closed, new operations are refused before they start and nothing new is
 * spawned. Operations admitted earlier are counted until they settle and
 * their reply is flushed. The closed state is persisted, so a supervisor that
 * restarts (including the candidate build in a trial) starts fenced.
 */

export type FencePhase = "fencing" | "fenced" | "activating";

export type FenceRecord = {
  format: 1;
  attemptId: string;
  target: RunnerUpdateTarget;
  retainSessions: boolean;
  phase: FencePhase;
  startedAt: number;
  /** Authoritative retained set recorded at `fence_ready`. */
  retained: RetainedSession[];
};

export type FenceStore = {
  /** Null when absent. Throws when the state exists but cannot be trusted. */
  read(): Promise<FenceRecord | null>;
  write(record: FenceRecord): Promise<void>;
  clear(): Promise<void>;
};

export type AdmissionTicket = {
  /** Idempotent. */
  release(): void;
};

export type DrainOutcome = "drained" | "timeout" | "cancelled" | "store_failed";

export const UPDATE_FENCED_MESSAGE =
  "The runner is updating; the operation was not started.";
export const TERMINAL_UPDATE_MESSAGE =
  "The runner is updating. This terminal was closed; reopen it after the update.";
/** Time for a reply already produced by an admitted operation to flush. */
export const FENCE_FLUSH_MARGIN_MS = 5_000;
export const TERMINAL_UPDATE_GRACE_MS = 5_000;

type Admitted = { deadlineAt: number };

export class UpdateAdmission {
  private record: FenceRecord | null;
  /** Closed by state that exists but cannot be read; any cancel clears it. */
  private untrusted: boolean;
  private generation = 0;
  private pendingStore = Promise.resolve();
  private readonly admitted = new Set<Admitted>();
  private readonly terminals = new Set<() => void>();
  private terminalTimer?: ReturnType<typeof setTimeout>;
  private terminalsClosed = false;
  private wake?: () => void;
  private terminalsSettled?: () => void;

  private constructor(
    private readonly store: FenceStore,
    initial: FenceRecord | null,
    untrusted: boolean,
    private readonly terminalGraceMs: number,
    private readonly log: (message: string) => void
  ) {
    this.record = initial;
    this.untrusted = untrusted;
    // A restarted supervisor has no terminals to close and admitted nothing.
    this.terminalsClosed = initial !== null || untrusted;
  }

  /** Read persisted state. Missing state is open; unreadable state fails closed. */
  static async load(
    store: FenceStore,
    options: {
      terminalGraceMs?: number;
      log?: (message: string) => void;
    } = {}
  ) {
    const log = options.log ?? ((message: string) => console.warn(message));
    let record: FenceRecord | null = null;
    let untrusted = false;
    try {
      record = await store.read();
    } catch (error) {
      untrusted = true;
      log(
        `Runner update fence state is unreadable; admission stays closed: ${(error as Error).message}`
      );
    }
    return new UpdateAdmission(
      store,
      record,
      untrusted,
      options.terminalGraceMs ?? TERMINAL_UPDATE_GRACE_MS,
      log
    );
  }

  get closed() {
    return this.record !== null || this.untrusted;
  }

  get current(): FenceRecord | null {
    return this.record;
  }

  get unreadable() {
    return this.untrusted;
  }

  get inFlight() {
    return this.admitted.size;
  }

  /**
   * Admit one operation, or null when the gate is closed. Call before any
   * asynchronous step so admission order follows frame order.
   */
  admit(deadlineMs: number): AdmissionTicket | null {
    if (this.closed) return null;
    const entry: Admitted = { deadlineAt: Date.now() + deadlineMs };
    this.admitted.add(entry);
    return {
      release: () => {
        if (this.admitted.delete(entry)) this.wake?.();
      },
    };
  }

  /**
   * Whether a process may start now. True while open, and while closing only
   * for operations admitted before the gate closed. Never once drained.
   */
  mayStartProcess() {
    if (!this.closed) return true;
    return this.record?.phase === "fencing" && this.admitted.size > 0;
  }

  /** Throws unless a process may start now. */
  assertMayStartProcess() {
    if (!this.mayStartProcess()) throw new Error(UPDATE_FENCED_MESSAGE);
  }

  /** A terminal to close with the update reason after the grace period. */
  onTerminal(close: () => void) {
    if (this.closed && this.terminalsClosed) {
      close();
      return () => {};
    }
    this.terminals.add(close);
    return () => this.terminals.delete(close);
  }

  /**
   * Close the gate for `record` and wait for admitted operations. The gate
   * closes synchronously; the record is persisted before draining. On timeout
   * the gate reopens, so a stalled operation defers the update.
   */
  async fence(record: Omit<FenceRecord, "startedAt">): Promise<DrainOutcome> {
    if (this.closed) throw new Error("The update fence is already closed.");
    const generation = ++this.generation;
    const next: FenceRecord = {
      ...record,
      phase: "fencing",
      retained: [],
      startedAt: Date.now(),
    };
    this.record = next;
    this.terminalsClosed = false;
    try {
      await this.updateStore(() => this.store.write(next));
    } catch {
      if (generation === this.generation) await this.release();
      return "store_failed";
    }
    while (true) {
      if (generation !== this.generation) return "cancelled";
      if (this.admitted.size === 0) return "drained";
      const deadline =
        Math.max(...[...this.admitted].map((entry) => entry.deadlineAt)) +
        FENCE_FLUSH_MARGIN_MS;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.release();
        return "timeout";
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, remaining);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
  }

  /** Close terminals only after the drain and handoff checks have passed. */
  async closeTerminals() {
    if (this.terminalsClosed) return;
    if (!this.terminals.size) {
      this.terminalsClosed = true;
      return;
    }
    const generation = this.generation;
    await new Promise<void>((resolve) => {
      this.terminalsSettled = resolve;
      this.terminalTimer = setTimeout(() => {
        this.terminalsClosed = true;
        for (const close of [...this.terminals]) {
          this.terminals.delete(close);
          try {
            close();
          } catch {
            // A terminal that is already closing needs nothing more.
          }
        }
        resolve();
      }, this.terminalGraceMs);
    });
    if (generation === this.generation) {
      this.terminalsSettled = undefined;
      this.terminalTimer = undefined;
    }
  }

  /** Advance the persisted phase of the current fence. */
  async advance(phase: "fenced" | "activating", retained?: RetainedSession[]) {
    if (!this.record) throw new Error("No update fence is closed.");
    const next: FenceRecord = {
      ...this.record,
      phase,
      ...(retained && { retained }),
    };
    const generation = this.generation;
    await this.updateStore(() => this.store.write(next));
    if (generation !== this.generation) return false;
    this.record = next;
    return true;
  }

  private updateStore(action: () => Promise<void>) {
    const pending = this.pendingStore.then(action);
    this.pendingStore = pending.catch(() => {});
    return pending;
  }

  /** Reopen admission and remove the persisted fence. */
  async release() {
    this.generation++;
    this.record = null;
    this.untrusted = false;
    this.terminalsClosed = false;
    clearTimeout(this.terminalTimer);
    this.terminalTimer = undefined;
    this.wake?.();
    this.terminalsSettled?.();
    this.terminalsSettled = undefined;
    try {
      await this.updateStore(() => this.store.clear());
    } catch (error) {
      this.log(
        `Runner admission reopened but could not remove the persisted update fence: ${(error as Error).message}`
      );
    }
  }
}
