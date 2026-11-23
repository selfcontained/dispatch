import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { EXEC_OPS, WORKER_OPS } from "../platform/types.js";

/**
 * Operations a frozen runner still serves: they read and change nothing. A
 * `read` retry rule is not enough (`session.stop` is repeatable and writes),
 * so the list is explicit; anything not named is refused with `fenced`.
 */
export const SERVED_WHILE_FROZEN: ReadonlySet<string> = new Set([
  "runner.describe",
  "runner.health",
  "session.list",
  "session.sample",
  // Session reads, and the attach channel: it relays the app's frames to a
  // host process and writes nothing of the runner's. An update's probation
  // attaches to the hosts that survived it.
  "session.alive",
  "session.logs",
  "session.attach",
  "workspace.describe",
  // Checkout reads write nothing of the runner's. While frozen, Git also
  // skips its optional index refresh in the checkout (`GIT_OPTIONAL_LOCKS`).
  ...WORKER_OPS,
  // The watch channel only reports changes others make.
  "checkout.watch",
  // GitHub reads write nothing of the runner's or the checkout's.
  "github.pr.status",
  "github.pr.details",
  "github.pr.diff",
]);

/**
 * Commands a frozen runner refuses but `freeze` does not wait for. A command
 * may run for as long as it likes, and a caller that stops waiting leaves it
 * running (main's repo tools); the caller's own drain waits for the commands
 * it is still waiting on, as main's update drain waits for its requests.
 */
/**
 * A stop that only waits for an idle host to exit by itself, as an update's
 * probation stops the idle hosts that survived it: served while frozen. It
 * signals nothing that is still running.
 */
function idleStop(op: string, request: unknown) {
  return (
    op === "session.stop" &&
    typeof request === "object" &&
    request !== null &&
    (request as { idleOnly?: unknown }).idleOnly === true
  );
}

export const NOT_AWAITED: ReadonlySet<string> = new Set(EXEC_OPS);

export const fencedError = () =>
  new RunnerCallError({
    code: "fenced",
    message: "The runner is frozen for an update",
  });

/**
 * Git's optional locks let a read refresh the checkout's index. A frozen
 * runner's Git reads skip it, so nothing is written; thawed, Git behaves as
 * it does for any other reader. Workload Git inherits the runner's
 * environment.
 */
let saved: { value: string | undefined } | null = null;
function optionalLocks(on: boolean) {
  if (!on) {
    saved ??= { value: process.env.GIT_OPTIONAL_LOCKS };
    process.env.GIT_OPTIONAL_LOCKS = "0";
    return;
  }
  if (!saved) return;
  if (saved.value === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
  else process.env.GIT_OPTIONAL_LOCKS = saved.value;
  saved = null;
}

/**
 * The updater's write fence inside the runner. While frozen, admission
 * refuses every operation outside `SERVED_WHILE_FROZEN` before its handler
 * runs. `freeze` resolves only once the writes admitted before it have
 * finished (commands excepted, `NOT_AWAITED`), so its answer means none of
 * the runner's own writes is running.
 */
export class WriteFence {
  private frozenNow: boolean;
  private inFlight = 0;
  private idle: Array<() => void> = [];

  constructor(frozen = false) {
    this.frozenNow = frozen;
    if (frozen) optionalLocks(false);
  }

  get frozen(): boolean {
    return this.frozenNow;
  }

  /**
   * Admit one operation. Returns its release (call when it has finished), or
   * null when it is refused because the runner is frozen.
   */
  enter(op: string, request?: unknown): (() => void) | null {
    if (SERVED_WHILE_FROZEN.has(op) || idleStop(op, request)) return () => {};
    if (this.frozenNow) return null;
    if (NOT_AWAITED.has(op)) return () => {};
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
    optionalLocks(false);
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  thaw(): void {
    this.frozenNow = false;
    optionalLocks(true);
  }
}
