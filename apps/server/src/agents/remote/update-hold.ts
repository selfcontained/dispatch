import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import {
  readPrivate,
  syncDirectory,
  writeAtomic,
} from "../../update-recovery/files.js";

/**
 * Dispatch's side of a runner update fence: while a runner is held, new work
 * for agents placed on it waits in Dispatch's existing queues instead of
 * reaching the runner. Prompts and scheduled occurrences wait in the agent
 * runtime's own queue (the same gate a disconnected runner uses), launches
 * are recorded here before any attempt is made, and stop/discard wait on
 * the gate. Nothing here decides when to update; a coordinator begins a
 * hold for one attempt and releases it with an outcome.
 *
 * A hold is bounded: it opens by itself at `expiresAt` (outcome `expired`)
 * and held work then takes its ordinary path, failing visibly if the runner
 * still refuses it. The bound is persisted, so a restart never extends it.
 */

/** Generous: the runner's own fence expires after six minutes, plus trial. */
export const RUNNER_HOLD_BOUND_MS = 15 * 60 * 1000;

export type RunnerHoldOutcome =
  /** The new build was confirmed. */
  | "committed"
  /** The trial failed and the previous build is back. */
  | "rolled_back"
  /** Aborted or cancelled before the swap. */
  | "cancelled"
  /** The runner reported its fence released or expired. */
  | "fence_released"
  /** Dispatch's own bound elapsed. */
  | "expired";

const seededFile = z
  .object({
    fileId: z.number(),
    fileName: z.string(),
    displayName: z.string(),
    source: z.string(),
    description: z.string().nullable(),
  })
  .strict();

const promptImage = z
  .object({
    path: z.string(),
    mimeType: z.string(),
    runnerName: z.string().optional(),
  })
  .strict();

const heldLaunch = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().regex(/^agt_[A-Za-z0-9_-]{1,64}$/),
    heldAt: z.string().datetime(),
    /** A new agent's first launch, or a start of an existing one. */
    kind: z.enum(["create", "start"]),
    /** What only the create promise knew: its first turn. */
    create: z
      .object({
        initialPrompt: z.string().optional(),
        initialFiles: z.array(seededFile).max(1000),
        chatLaunchPost: z
          .object({
            messageId: z.string(),
            attachmentLines: z.array(z.string()),
            images: z.array(promptImage).optional(),
          })
          .strict()
          .nullable(),
        jobRunId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HeldLaunch = z.infer<typeof heldLaunch>;

const runnerHold = z
  .object({
    runnerId: z.string().min(1).max(256),
    attemptId: z.string().uuid(),
    beganAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    launches: z.array(heldLaunch).max(10_000),
  })
  .strict();
export type RunnerHold = z.infer<typeof runnerHold>;

const holdFile = z
  .object({ format: z.literal(1), holds: z.array(runnerHold).max(1000) })
  .strict();

export type RunnerHoldStore = {
  read(): Promise<RunnerHold[]>;
  write(holds: RunnerHold[]): Promise<void>;
};

/** A private file, replaced atomically; absent when nothing is held. */
export function fileRunnerHoldStore(
  file: string,
  logger?: Pick<FastifyBaseLogger, "warn">
): RunnerHoldStore {
  return {
    async read() {
      let raw: string;
      try {
        raw = await readPrivate(file, { maxBytes: 16 * 1024 * 1024 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        return setAside(error);
      }
      let parsed: ReturnType<typeof holdFile.safeParse>;
      try {
        parsed = holdFile.safeParse(JSON.parse(raw));
      } catch (error) {
        return setAside(error);
      }
      if (!parsed.success) return setAside(parsed.error);
      return parsed.data.holds;
    },
    async write(holds) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeAtomic(
        file,
        JSON.stringify(holdFile.parse({ format: 1, holds }))
      );
    },
  };

  // An unreadable record holds nothing: held work then takes its ordinary
  // path (a still-fenced runner refuses it visibly). Kept for inspection.
  async function setAside(error: unknown): Promise<RunnerHold[]> {
    logger?.warn(
      { err: error, file },
      "runner update hold state is unreadable; holding nothing"
    );
    await rename(file, `${file}.rejected-${Date.now()}`).catch(() => null);
    await syncDirectory(path.dirname(file)).catch(() => null);
    return [];
  }
}

export type HeldCounts = {
  prompts: number;
  scheduled: number;
  launches: number;
  stops: number;
};

export type RunnerHoldRelease = {
  runnerId: string;
  attemptId: string;
  outcome: RunnerHoldOutcome;
  /** Held launches, oldest first. Already removed from the record. */
  launches: HeldLaunch[];
};

export class RunnerHoldConflict extends Error {}

type Live = RunnerHold & { timer?: ReturnType<typeof setTimeout> };

/**
 * The interface the update coordinator drives: `begin`, `release`, `counts`.
 * Everything else is for the code paths that hold work.
 */
export class RunnerUpdateHolds {
  private readonly holds = new Map<string, Live>();
  private readonly waiters = new Map<
    string,
    { kind: "stop" | "other"; resolve: () => void }[]
  >();
  private readonly releaseListeners = new Set<
    (release: RunnerHoldRelease) => void | Promise<void>
  >();
  private readonly counters = new Set<
    (runnerId: string) => Partial<HeldCounts>
  >();
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly boundMs: number;

  constructor(
    private readonly options: {
      store: RunnerHoldStore;
      logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
      boundMs?: number;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? Date.now;
    this.boundMs = options.boundMs ?? RUNNER_HOLD_BOUND_MS;
  }

  /** Read persisted holds. Expiry is armed by `start`, after boot recovery. */
  async load(): Promise<void> {
    for (const hold of await this.options.store.read())
      this.holds.set(hold.runnerId, { ...hold });
    if (this.holds.size)
      this.options.logger.info(
        { runners: [...this.holds.keys()] },
        "runner update holds restored"
      );
  }

  /** Arm each bound; one already past releases now. */
  start(): void {
    for (const hold of this.holds.values()) this.arm(hold);
  }

  close(): void {
    for (const hold of this.holds.values()) clearTimeout(hold.timer);
  }

  async begin(
    runnerId: string,
    attemptId: string,
    options: { boundMs?: number } = {}
  ): Promise<RunnerHold> {
    const existing = this.holds.get(runnerId);
    if (existing) {
      if (existing.attemptId === attemptId) return snapshot(existing);
      throw new RunnerHoldConflict(
        "Another update attempt is holding this runner."
      );
    }
    const now = this.now();
    const hold: Live = {
      runnerId,
      attemptId,
      beganAt: new Date(now).toISOString(),
      expiresAt: new Date(
        now + (options.boundMs ?? this.boundMs)
      ).toISOString(),
      launches: [],
    };
    this.holds.set(runnerId, hold);
    try {
      await this.persist();
    } catch (error) {
      if (this.holds.get(runnerId) === hold) this.holds.delete(runnerId);
      throw error;
    }
    this.arm(hold);
    this.options.logger.info(
      { runnerId, attemptId, expiresAt: hold.expiresAt },
      "runner update hold began"
    );
    return snapshot(hold);
  }

  /**
   * Open the gate for this attempt. True exactly once; a stale or repeated
   * release changes nothing. The record is gone before any work moves.
   */
  async release(
    runnerId: string,
    attemptId: string,
    outcome: RunnerHoldOutcome
  ): Promise<boolean> {
    const hold = this.holds.get(runnerId);
    if (!hold || hold.attemptId !== attemptId) return false;
    this.holds.delete(runnerId);
    clearTimeout(hold.timer);
    try {
      await this.persist();
    } catch (error) {
      // Opening matters more than the record: a stale file is at worst a
      // hold that expires by its persisted bound after a restart.
      this.options.logger.error(
        { err: error, runnerId, attemptId },
        "could not persist runner hold release; opening it anyway"
      );
    }
    this.options.logger.info(
      { runnerId, attemptId, outcome, launches: hold.launches.length },
      "runner update hold released"
    );
    for (const waiter of this.waiters.get(runnerId)?.splice(0) ?? [])
      waiter.resolve();
    this.waiters.delete(runnerId);
    const release: RunnerHoldRelease = {
      runnerId,
      attemptId,
      outcome,
      launches: hold.launches,
    };
    for (const listener of this.releaseListeners) {
      try {
        await listener(release);
      } catch (error) {
        this.options.logger.error(
          { err: error, runnerId, attemptId },
          "runner hold release listener failed"
        );
      }
    }
    return true;
  }

  isHeld(runnerId: string | null | undefined): boolean {
    return runnerId != null && this.holds.has(runnerId);
  }

  current(runnerId: string): RunnerHold | undefined {
    const hold = this.holds.get(runnerId);
    return hold && snapshot(hold);
  }

  /** Resolves once the runner is not held (now, if it is not). */
  wait(runnerId: string, kind: "stop" | "other" = "other"): Promise<void> {
    if (!this.holds.has(runnerId)) return Promise.resolve();
    return new Promise((resolve) => {
      const queue = this.waiters.get(runnerId) ?? [];
      queue.push({ kind, resolve });
      this.waiters.set(runnerId, queue);
    });
  }

  /** Persist a launch to run on release. False when the runner is not held. */
  async holdLaunch(
    runnerId: string,
    launch: Omit<HeldLaunch, "id" | "heldAt">
  ): Promise<boolean> {
    const hold = this.holds.get(runnerId);
    if (!hold) return false;
    // One intent per agent; a newer one replaces the older.
    hold.launches = hold.launches.filter((l) => l.agentId !== launch.agentId);
    hold.launches.push(
      heldLaunch.parse({
        ...launch,
        id: randomUUID(),
        heldAt: new Date(this.now()).toISOString(),
      })
    );
    await this.persist();
    return true;
  }

  hasLaunch(agentId: string): boolean {
    for (const hold of this.holds.values())
      if (hold.launches.some((l) => l.agentId === agentId)) return true;
    return false;
  }

  /** Cancel a held launch (stop/archive won). */
  async takeLaunch(agentId: string): Promise<HeldLaunch | undefined> {
    for (const hold of this.holds.values()) {
      const launch = hold.launches.find((l) => l.agentId === agentId);
      if (!launch) continue;
      hold.launches = hold.launches.filter((l) => l !== launch);
      await this.persist();
      return launch;
    }
    return undefined;
  }

  onRelease(
    listener: (release: RunnerHoldRelease) => void | Promise<void>
  ): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** Contribute counts of work held elsewhere (the runtime's queue). */
  countWith(counter: (runnerId: string) => Partial<HeldCounts>): () => void {
    this.counters.add(counter);
    return () => this.counters.delete(counter);
  }

  /** What is waiting on this runner, by kind, for the UI. */
  counts(runnerId: string): HeldCounts {
    const hold = this.holds.get(runnerId);
    const counts: HeldCounts = {
      prompts: 0,
      scheduled: 0,
      launches: hold?.launches.length ?? 0,
      stops:
        this.waiters.get(runnerId)?.filter((w) => w.kind === "stop").length ??
        0,
    };
    if (!hold) return counts;
    for (const counter of this.counters) {
      const more = counter(runnerId);
      counts.prompts += more.prompts ?? 0;
      counts.scheduled += more.scheduled ?? 0;
    }
    return counts;
  }

  private arm(hold: Live): void {
    clearTimeout(hold.timer);
    const delay = Math.max(0, Date.parse(hold.expiresAt) - this.now());
    hold.timer = setTimeout(() => {
      if (this.holds.get(hold.runnerId) !== hold) return;
      this.options.logger.warn(
        { runnerId: hold.runnerId, attemptId: hold.attemptId },
        "runner update hold reached its bound; releasing held work"
      );
      void this.release(hold.runnerId, hold.attemptId, "expired");
    }, delay);
    hold.timer.unref?.();
  }

  /** Writes are serialized and each carries the whole current state. */
  private persist(): Promise<void> {
    const write = this.writes
      .catch(() => {})
      .then(() =>
        this.options.store.write(
          [...this.holds.values()].map((hold) => snapshot(hold))
        )
      );
    this.writes = write;
    return write;
  }
}

function snapshot(hold: Live): RunnerHold {
  return {
    runnerId: hold.runnerId,
    attemptId: hold.attemptId,
    beganAt: hold.beganAt,
    expiresAt: hold.expiresAt,
    launches: [...hold.launches],
  };
}
