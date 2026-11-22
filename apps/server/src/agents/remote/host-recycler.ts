import type { FastifyBaseLogger } from "fastify";
import type { RunnerHostIdentity } from "../runtime.js";

const SETTLEMENT_DELAY_MS = 1_000;
const RESCAN_DELAY_MS = 5_000;

export type ConfirmedRunnerUpdate = {
  runnerId: string;
  attemptId: string;
  revision: string;
  sha256: string;
};

export type RunnerHostRecycleProgress = {
  oldBuild: number;
  recycled: number;
  waiting: number;
};

type Recycling = {
  update: ConfirmedRunnerUpdate;
  old: Set<string>;
  inFlight: Set<string>;
  recycled: Set<string>;
  timer?: NodeJS.Timeout;
  early?: boolean;
};

export class RunnerHostRecycler {
  private readonly runs = new Map<string, Recycling>();
  /** Outlives `stop`: an accepted shutdown still finishes its restart. */
  private readonly restarts = new Map<string, Set<Promise<unknown>>>();

  constructor(
    private readonly deps: {
      hosts(runnerId: string): RunnerHostIdentity[];
      recycle(
        update: ConfirmedRunnerUpdate,
        host: RunnerHostIdentity,
        active: () => boolean
      ): Promise<boolean>;
      logger: FastifyBaseLogger;
    }
  ) {}

  start(update: ConfirmedRunnerUpdate): void {
    if (this.runs.get(update.runnerId)?.update.attemptId === update.attemptId)
      return;
    this.stop(update.runnerId);
    const run: Recycling = {
      update,
      old: new Set(),
      inFlight: new Set(),
      recycled: new Set(),
    };
    this.runs.set(update.runnerId, run);
    this.scan(run);
  }

  progress(runnerId: string): RunnerHostRecycleProgress | null {
    const run = this.runs.get(runnerId);
    return run
      ? {
          oldBuild: run.old.size,
          recycled: run.recycled.size,
          waiting: [...run.old].filter((id) => !run.inFlight.has(id)).length,
        }
      : null;
  }

  stop(runnerId: string): void {
    clearTimeout(this.runs.get(runnerId)?.timer);
    this.runs.delete(runnerId);
  }

  /** Stop the pass and wait for the probes and restarts already under way. */
  async stopAndSettle(runnerId: string): Promise<void> {
    this.stop(runnerId);
    await Promise.all(this.restarts.get(runnerId) ?? []);
  }

  settled(agentId: string): void {
    for (const run of this.runs.values()) {
      if (!run.old.has(agentId) || run.inFlight.has(agentId)) continue;
      if (run.early) continue;
      this.schedule(run, SETTLEMENT_DELAY_MS);
    }
  }

  private schedule(run: Recycling, delay: number): void {
    clearTimeout(run.timer);
    run.early = delay === SETTLEMENT_DELAY_MS;
    run.timer = setTimeout(() => this.scan(run), delay);
    run.timer.unref();
  }

  private scan(run: Recycling): void {
    const { update } = run;
    const active = () => this.runs.get(update.runnerId) === run;
    if (!active()) return;
    const old = this.deps
      .hosts(update.runnerId)
      .filter(
        (host) =>
          host.build?.revision && host.build.revision !== update.revision
      );
    run.old = new Set(old.map((host) => host.agentId));
    for (const host of old) {
      if (
        !host.instanceId ||
        !host.quiesceSupported ||
        run.inFlight.has(host.agentId)
      )
        continue;
      run.inFlight.add(host.agentId);
      const restart = this.deps
        .recycle(update, host, active)
        .then((recycled) => {
          if (recycled) {
            run.old.delete(host.agentId);
            run.recycled.add(host.agentId);
          }
        })
        .catch((error) => {
          this.deps.logger.warn(
            { error, agentId: host.agentId },
            "Runner host recycle failed"
          );
        })
        .finally(() => {
          run.inFlight.delete(host.agentId);
          const restarts = this.restarts.get(update.runnerId);
          restarts?.delete(restart);
          if (!restarts?.size) this.restarts.delete(update.runnerId);
        });
      const restarts = this.restarts.get(update.runnerId) ?? new Set();
      this.restarts.set(update.runnerId, restarts.add(restart));
    }
    this.schedule(run, RESCAN_DELAY_MS);
  }
}
