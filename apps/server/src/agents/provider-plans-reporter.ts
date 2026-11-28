import type { ProviderPlansResponse } from "@dispatch/runner-protocol/engine-plans";

function observationTime(value: string | null): number {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** A forced refresh still reuses a report this young: a guard on the provider. */
const FORCE_REFRESH_FLOOR_MS = 5_000;

/**
 * Cached for a minute; `force` (the dialog's Refresh) asks again unless the
 * last answer is only seconds old. A failed refresh keeps the last good
 * windows for that engine and adds the reason.
 */
export type ProviderPlansReporter = ((request?: {
  force?: boolean;
}) => Promise<ProviderPlansResponse>) & {
  /** Forget the cached report, so the next ask reads the providers again. */
  invalidate: () => void;
  /**
   * Called with every report a load puts in the cache, whoever asked for it
   * (UI, get_usage, usage watches). Returns an unsubscribe. A listener that
   * throws or rejects never affects the caller's report.
   */
  onReport: (
    listener: (report: ProviderPlansResponse) => unknown
  ) => () => void;
};

export function createProviderPlansReporter(
  options: {
    log?: { warn: (fields: Record<string, unknown>, message: string) => void };
    load: () => Promise<ProviderPlansResponse>;
  },
  cacheMs = 60_000
): ProviderPlansReporter {
  const read = options.load;
  let cached: { loadedAt: number; report: ProviderPlansResponse } | null = null;
  let pending: Promise<ProviderPlansResponse> | null = null;
  // Bumped by invalidate(): a load begun before it may still finish, but it
  // may neither be joined nor fill the cache, so a read after a reset never
  // sees the windows as they were before it.
  let generation = 0;
  const listeners = new Set<(report: ProviderPlansResponse) => unknown>();
  const report = async (request: { force?: boolean } = {}) => {
    const now = Date.now();
    if (
      cached &&
      now - cached.loadedAt < (request.force ? FORCE_REFRESH_FLOOR_MS : cacheMs)
    ) {
      return cached.report;
    }
    if (pending) return pending;
    const started = generation;
    const load = read()
      .then((report) => {
        if (started !== generation) return report;
        report.providers = report.providers.map((plan) => {
          const previous = cached?.report.providers.find(
            (candidate) => candidate.engine === plan.engine
          );
          return previous &&
            plan.unavailableReason &&
            observationTime(previous.observedAt) >
              observationTime(plan.observedAt)
            ? { ...previous, unavailableReason: plan.unavailableReason }
            : plan;
        });
        cached = { loadedAt: Date.now(), report };
        for (const listener of listeners) {
          try {
            void Promise.resolve(listener(report)).catch((err: unknown) =>
              options.log?.warn({ err }, "usage report listener failed")
            );
          } catch (err) {
            options.log?.warn({ err }, "usage report listener failed");
          }
        }
        return report;
      })
      .finally(() => {
        if (pending === load) pending = null;
      });
    pending = load;
    return load;
  };
  return Object.assign(report, {
    invalidate: () => {
      generation += 1;
      cached = null;
      pending = null;
    },
    onReport: (listener: (report: ProviderPlansResponse) => unknown) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
}
