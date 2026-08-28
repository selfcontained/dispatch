import type { FastifyBaseLogger } from "fastify";
import type { InjectionHoldState } from "@dispatch/shared";

// Canonical home is `@dispatch/shared` — the state is a wire payload the web
// client reads too. Re-exported so existing importers keep resolving.
export type { InjectionHoldState } from "@dispatch/shared";

// The web terminal and automated flows (reviews, agent messages, quick
// phrases, media drops) all write into the same tmux pane. The coordinator
// makes automated writes polite: injections for an agent run one at a time,
// and each waits for a quiet window since the user's last terminal
// interaction before touching the pane. User-initiated insertions
// (quick phrases, media) skip the quiet gate — they are the user acting and
// are meant to land at the cursor — but still serialize so they cannot
// interleave with an in-flight automated injection.
export class InjectionCoordinator {
  private static readonly DEFAULT_QUIET_MS = 10_000;
  private static readonly DEFAULT_MAX_WAIT_MS = 60_000;

  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly log: FastifyBaseLogger | undefined;
  private readonly onHoldChange:
    | ((agentId: string, state: InjectionHoldState) => void)
    | undefined;
  private readonly gateEnabled: () => boolean;
  private readonly lastActivityMs = new Map<string, number>();
  // Two lanes per agent: gated injections serialize among themselves through
  // gateTails (FIFO across quiet-gate waits), while writeTails serializes the
  // actual pane writes for everyone. Ungated (user-initiated) tasks join only
  // writeTails, so they never wait behind an injection that is still parked
  // at the quiet gate — only behind a write that is actively touching the pane.
  private readonly gateTails = new Map<string, Promise<void>>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly heldCounts = new Map<string, number>();
  private readonly pendingCounts = new Map<string, number>();
  private readonly releaseEpochs = new Map<string, number>();
  private readonly releaseWaiters = new Map<string, Set<() => void>>();

  constructor(
    opts: {
      quietMs?: number;
      maxWaitMs?: number;
      log?: FastifyBaseLogger;
      onHoldChange?: (agentId: string, state: InjectionHoldState) => void;
      // Feature toggle for the quiet gate. When it returns false, gated
      // injections skip the hold entirely (write serialization stays on).
      gateEnabled?: () => boolean;
    } = {}
  ) {
    this.quietMs = opts.quietMs ?? InjectionCoordinator.DEFAULT_QUIET_MS;
    this.maxWaitMs = opts.maxWaitMs ?? InjectionCoordinator.DEFAULT_MAX_WAIT_MS;
    this.log = opts.log;
    this.onHoldChange = opts.onHoldChange;
    this.gateEnabled = opts.gateEnabled ?? (() => true);
  }

  holdState(agentId: string): InjectionHoldState {
    return {
      held: (this.heldCounts.get(agentId) ?? 0) > 0,
      pendingCount: this.pendingCounts.get(agentId) ?? 0,
      quietMs: this.quietMs,
    };
  }

  // "Send now": skip the quiet gate for every injection currently enqueued
  // for the agent. Injections enqueued after this call gate normally again.
  releaseHold(agentId: string): void {
    this.releaseEpochs.set(agentId, (this.releaseEpochs.get(agentId) ?? 0) + 1);
    const waiters = this.releaseWaiters.get(agentId);
    if (waiters) {
      for (const wake of waiters) {
        wake();
      }
    }
  }

  // Record that a user interacted with the agent's terminal (keystroke,
  // mouse, or scroll). Injections defer until this signal goes quiet.
  noteUserActivity(agentId: string): void {
    this.lastActivityMs.set(agentId, Date.now());
  }

  // Run `task` after all previously enqueued injections for the agent have
  // finished. With `gate` (default), additionally wait for the user-activity
  // signal to be quiet for `quietMs`, capped at `maxWaitMs` so delivery is
  // still guaranteed under continuous typing.
  async inject<T>(
    agentId: string,
    task: () => Promise<T>,
    opts: { gate?: boolean } = {}
  ): Promise<T> {
    if (opts.gate === false || !this.gateEnabled()) {
      return this.enqueueWrite(agentId, task);
    }
    const epochAtEnqueue = this.releaseEpochs.get(agentId) ?? 0;
    this.changeCount(this.pendingCounts, agentId, 1);
    const prev = this.gateTails.get(agentId) ?? Promise.resolve();
    const run = prev.then(async () => {
      await this.waitForQuiet(agentId, epochAtEnqueue);
      return this.enqueueWrite(agentId, task);
    });
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.gateTails.set(agentId, tail);
    void tail.then(() => {
      this.changeCount(this.pendingCounts, agentId, -1);
      if (this.gateTails.get(agentId) === tail) {
        this.gateTails.delete(agentId);
      }
    });
    return run;
  }

  private enqueueWrite<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeTails.get(agentId) ?? Promise.resolve();
    const run = prev.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeTails.set(agentId, tail);
    void tail.then(() => {
      if (this.writeTails.get(agentId) === tail) {
        this.writeTails.delete(agentId);
      }
    });
    return run;
  }

  private async waitForQuiet(
    agentId: string,
    epochAtEnqueue: number
  ): Promise<void> {
    const start = Date.now();
    let held = false;
    let wake: () => void = () => undefined;
    const wakeSet = this.releaseWaiters.get(agentId) ?? new Set<() => void>();
    this.releaseWaiters.set(agentId, wakeSet);
    try {
      for (;;) {
        if ((this.releaseEpochs.get(agentId) ?? 0) !== epochAtEnqueue) {
          return;
        }
        const last = this.lastActivityMs.get(agentId);
        const now = Date.now();
        if (last === undefined || now - last >= this.quietMs) {
          return;
        }
        if (now - start >= this.maxWaitMs) {
          this.log?.debug(
            { agentId, waitedMs: now - start },
            "Injection quiet-wait cap reached — delivering despite user activity"
          );
          return;
        }
        if (!held) {
          held = true;
          this.changeCount(this.heldCounts, agentId, 1);
        }
        const waitMs = Math.min(
          this.quietMs - (now - last),
          this.maxWaitMs - (now - start)
        );
        await new Promise<void>((resolve) => {
          wake = resolve;
          wakeSet.add(resolve);
          setTimeout(resolve, waitMs);
        });
        wakeSet.delete(wake);
      }
    } finally {
      wakeSet.delete(wake);
      if (wakeSet.size === 0 && this.releaseWaiters.get(agentId) === wakeSet) {
        this.releaseWaiters.delete(agentId);
      }
      if (held) {
        this.changeCount(this.heldCounts, agentId, -1);
      }
    }
  }

  private changeCount(
    counts: Map<string, number>,
    agentId: string,
    delta: number
  ): void {
    const next = (counts.get(agentId) ?? 0) + delta;
    if (next <= 0) {
      counts.delete(agentId);
    } else {
      counts.set(agentId, next);
    }
    try {
      this.onHoldChange?.(agentId, this.holdState(agentId));
    } catch {
      // Listener failures must never break injection delivery.
    }
  }
}
