import {
  getDiffStats as defaultGetDiffStats,
  type DiffStats,
} from "../shared/git/diff-stats.js";

export type DiffStatsAgent = {
  worktreePath: string | null;
  baseBranch: string | null;
};

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

  constructor(options: DiffStatsRefresherOptions) {
    this.getAgent = options.getAgent;
    this.publishEvent = options.publishEvent;
    this.computeDiffStats = options.computeDiffStats ?? defaultGetDiffStats;
    this.freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.logger = options.logger ?? null;
  }

  /**
   * Schedule a refresh for the given agent. No-op when a recent compute is
   * still warm; shares the in-flight promise when one is running.
   */
  signal(agentId: string): Promise<void> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;

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

  /**
   * Drop any cached state for an agent (archive/delete cleanup).
   */
  clear(agentId: string): void {
    this.cache.delete(agentId);
    this.lastSignaledAt.delete(agentId);
    this.inFlight.delete(agentId);
  }

  private async refresh(agentId: string): Promise<void> {
    let nextStats: DiffStats | null = null;
    try {
      const agent = await this.getAgent(agentId);
      if (!agent || !agent.worktreePath) {
        nextStats = null;
      } else {
        // Pass `agent.baseBranch` straight through — `getDiffStats` runs
        // it through the shared `resolveBaseRef` chain, so we don't bake a
        // second fallback policy in here.
        nextStats = await this.computeDiffStats(
          agent.worktreePath,
          agent.baseBranch
        );
      }
    } catch (err) {
      this.logger?.warn(
        { err, agentId },
        "Diff stats refresh failed; leaving cache unchanged"
      );
      return;
    }

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
