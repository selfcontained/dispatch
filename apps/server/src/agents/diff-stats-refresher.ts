import {
  getDiffStats as defaultGetDiffStats,
  type DiffStats,
} from "../shared/git/diff-stats.js";
import type { SubsystemTracker } from "../observability/subsystem-tracker.js";

export type DiffStatsAgent = {
  worktreePath: string | null;
  cwd: string | null;
  baseBranch: string | null;
  gitContext?: {
    worktreePath: string;
    isWorktree: boolean;
  } | null;
};

const DEFAULT_WORKTREE_BASE_BRANCH = "main";

export type DiffStatsChangedEvent = {
  type: "agent.diff_state_changed";
  agentId: string;
  diffStats: DiffStats | null;
};

type ComputeDiffStats = (
  worktreePath: string,
  baseRef: string | null
) => Promise<DiffStats | null>;

type WarnLogger = {
  warn: (...args: unknown[]) => void;
};

export type DiffStatsRefresherOptions = {
  getAgent: (id: string) => Promise<DiffStatsAgent | null>;
  publishEvent: (event: DiffStatsChangedEvent) => void;
  computeDiffStats?: ComputeDiffStats;
  freshnessMs?: number;
  logger?: WarnLogger;
  tracker?: SubsystemTracker;
};

const DEFAULT_FRESHNESS_MS = 3_000;

/**
 * In-memory cache + signal funnel for per-agent diff stats. Three callers
 * share the same throttle: agent status transitions, the GET diff-stats
 * route, and tap-to-refresh. The freshness window collapses bursts and the
 * in-flight map dedupes simultaneous signals so we don't fan out git
 * subprocesses across tabs.
 *
 * `signal` returns a promise that resolves once the (possibly shared)
 * compute settles, so callers can await if they care. Status-event callers
 * just fire-and-forget.
 */
export class DiffStatsRefresher {
  private readonly cache = new Map<string, DiffStats | null>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastSignaledAt = new Map<string, number>();

  private readonly getAgent: (id: string) => Promise<DiffStatsAgent | null>;
  private readonly publishEvent: (event: DiffStatsChangedEvent) => void;
  private readonly computeDiffStats: ComputeDiffStats;
  private readonly freshnessMs: number;
  private readonly logger: WarnLogger | null;
  private readonly tracker: SubsystemTracker | null;
  private signals = 0;
  private dedupedSignals = 0;

  constructor(options: DiffStatsRefresherOptions) {
    this.getAgent = options.getAgent;
    this.publishEvent = options.publishEvent;
    this.computeDiffStats =
      options.computeDiffStats ??
      (async (worktreePath, baseRef) => {
        let commandError: unknown = null;
        const stats = await defaultGetDiffStats(worktreePath, baseRef, {
          onError: (error) => {
            commandError = error;
          },
        });
        if (commandError !== null) throw commandError;
        return stats;
      });
    this.freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.logger = options.logger ?? null;
    this.tracker = options.tracker ?? null;
  }

  /**
   * Schedule a refresh for the given agent. No-op when a recent compute is
   * still warm; shares the in-flight promise when one is running.
   */
  signal(agentId: string): Promise<void> {
    this.signals += 1;
    const existing = this.inFlight.get(agentId);
    if (existing) {
      this.dedupedSignals += 1;
      return existing;
    }

    const last = this.lastSignaledAt.get(agentId) ?? 0;
    const now = Date.now();
    if (now - last < this.freshnessMs) {
      return Promise.resolve();
    }
    this.lastSignaledAt.set(agentId, now);

    const promise = this.refresh(agentId).finally(() => {
      this.inFlight.delete(agentId);
    });
    this.inFlight.set(agentId, promise);
    return promise;
  }

  /**
   * Read the cached value without triggering a refresh. Returns `null`
   * both when nothing is cached and when the cached value itself is null
   * (no worktree). Callers that need to distinguish should check via the
   * route + signal flow.
   */
  getStats(agentId: string): DiffStats | null {
    return this.cache.get(agentId) ?? null;
  }

  getMetrics(): {
    cacheEntries: number;
    inFlight: number;
    signals: number;
    dedupedSignals: number;
  } {
    return {
      cacheEntries: this.cache.size,
      inFlight: this.inFlight.size,
      signals: this.signals,
      dedupedSignals: this.dedupedSignals,
    };
  }

  /**
   * Drop any cached state for an agent (archive/delete cleanup).
   */
  clear(agentId: string): void {
    this.cache.delete(agentId);
    this.lastSignaledAt.delete(agentId);
    this.inFlight.delete(agentId);
  }

  private async refresh(agentId: string): Promise<void> {
    const trackedRun = this.tracker?.start();
    let nextStats: DiffStats | null = null;
    try {
      const agent = await this.getAgent(agentId);
      // Prefer the dispatch-managed worktreePath. Older rows can be missing
      // that column while still having a populated gitContext from a prior
      // probe, so use the probed worktree path before falling back to cwd.
      // `getDiffStats` returns null when the path isn't inside a repo.
      const gitContextWorktreePath = agent?.gitContext?.isWorktree
        ? agent.gitContext.worktreePath
        : null;
      const path =
        agent?.worktreePath ?? gitContextWorktreePath ?? agent?.cwd ?? null;
      if (!path) {
        nextStats = null;
      } else {
        // Managed worktree agents default to `main` elsewhere in Dispatch,
        // but older rows may still have a null baseBranch persisted. Keep
        // non-worktree agents on the shared resolver fallback chain while
        // forcing worktree-backed agents onto the intended default base.
        const baseRef =
          agent?.baseBranch ??
          (agent?.worktreePath || gitContextWorktreePath
            ? DEFAULT_WORKTREE_BASE_BRANCH
            : null);
        nextStats = await this.computeDiffStats(path, baseRef);
      }
    } catch (err) {
      trackedRun?.fail(err);
      this.logger?.warn(
        { err, agentId },
        "Diff stats refresh failed; leaving cache unchanged"
      );
      return;
    }

    trackedRun?.succeed({ files: nextStats?.files ?? 0 });

    const previous = this.cache.has(agentId)
      ? this.cache.get(agentId)
      : undefined;
    this.cache.set(agentId, nextStats);
    if (statsEqual(previous, nextStats)) return;
    this.publishEvent({
      type: "agent.diff_state_changed",
      agentId,
      diffStats: nextStats,
    });
  }
}

function statsEqual(
  a: DiffStats | null | undefined,
  b: DiffStats | null | undefined
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.added === b.added && a.deleted === b.deleted && a.files === b.files;
}
