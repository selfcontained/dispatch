import { randomBytes } from "node:crypto";
import type { PlanWindow, ProviderPlansResponse } from "@dispatch/shared";
import type { Pool } from "pg";

/**
 * Agent subscriptions to a provider's remaining usage crossing a threshold.
 *
 * The measured value is get_usage's `headroomPercent`: the tightest quota
 * window's remaining percentage (100 − usedPercent, clamped 0..100). A watch
 * fires once per episode — the first usable reading that matches while it is
 * armed — and rearms only after a reading moves REARM_MARGIN points back past
 * the threshold, so noisy readings around the line do not re-notify. A
 * reading is usable only when the provider reported at least one window with
 * a parseable observation time no older than STALE_AFTER_MS; anything else
 * leaves every watch exactly as it was.
 */

/** Types whose provider reports subscription windows. OpenCode never does. */
export const USAGE_WATCH_TYPES = ["claude", "codex"] as const;
export type UsageWatchType = (typeof USAGE_WATCH_TYPES)[number];
export const USAGE_WATCH_COMPARISONS = ["at_or_below", "at_or_above"] as const;
export type UsageWatchComparison = (typeof USAGE_WATCH_COMPARISONS)[number];

export const REARM_MARGIN = 5;
/** Matches get_usage's stale-report caveat. */
export const STALE_AFTER_MS = 15 * 60_000;
export const MAX_WATCHES_PER_AGENT = 20;
/** Background refresh cadence while any live watch exists. */
export const USAGE_WATCH_TICK_MS = 2 * 60_000;

export type RemainingWindow = PlanWindow & { remainingPercent: number };

/** The same per-window remaining percentage get_usage reports. */
export function withRemaining(
  windows: readonly PlanWindow[]
): RemainingWindow[] {
  return windows.map((window) => ({
    ...window,
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
  }));
}

export type UsageReading = {
  type: UsageWatchType;
  /** False: unknown, unavailable or stale — never a match or a rearm. */
  usable: boolean;
  /** Why it is not usable, when it is not. */
  reason?: string;
  headroomPercent: number | null;
  tightestWindow: {
    id: string;
    label: string;
    remainingPercent: number;
    resetsAt: string | null;
  } | null;
  windows: Array<{
    id: string;
    label: string;
    remainingPercent: number;
    resetsAt: string | null;
  }>;
  observedAt: string | null;
  source: "live" | "local" | null;
  limitReached: boolean | null;
  unavailableReason: string | null;
  checkedAt: string;
};

export function usageReading(
  report: ProviderPlansResponse,
  type: UsageWatchType,
  now: number = Date.now()
): UsageReading {
  const plan = report.providers.find((provider) => provider.engine === type);
  const windows = withRemaining(plan?.windows ?? []).filter((window) =>
    Number.isFinite(window.remainingPercent)
  );
  const tightest = windows.length
    ? windows.reduce((a, b) =>
        b.remainingPercent < a.remainingPercent ? b : a
      )
    : null;
  const observedMs = plan?.observedAt ? Date.parse(plan.observedAt) : NaN;
  const reason = !plan
    ? "No usage report available."
    : windows.length === 0
      ? (plan.unavailableReason ?? "The report has no quota windows.")
      : !Number.isFinite(observedMs)
        ? "The report has no observation time."
        : now - observedMs > STALE_AFTER_MS
          ? `The newest report is older than ${STALE_AFTER_MS / 60_000} minutes.`
          : undefined;
  const brief = (window: RemainingWindow) => ({
    id: window.id,
    label: window.label,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt ?? null,
  });
  return {
    type,
    usable: reason === undefined,
    ...(reason ? { reason } : {}),
    headroomPercent: tightest?.remainingPercent ?? null,
    tightestWindow: tightest ? brief(tightest) : null,
    windows: windows.map(brief),
    observedAt: plan?.observedAt ?? null,
    source: plan?.source ?? null,
    limitReached: plan?.limitReached ?? null,
    unavailableReason: plan?.unavailableReason ?? null,
    checkedAt: report.checkedAt,
  };
}

export function conditionMatches(
  comparison: UsageWatchComparison,
  threshold: number,
  headroom: number
): boolean {
  return comparison === "at_or_below"
    ? headroom <= threshold
    : headroom >= threshold;
}

/** Back past the threshold by the margin (clamped to the 0..100 range). */
export function conditionRearms(
  comparison: UsageWatchComparison,
  threshold: number,
  headroom: number
): boolean {
  return comparison === "at_or_below"
    ? headroom > threshold &&
        headroom >= Math.min(100, threshold + REARM_MARGIN)
    : headroom < threshold && headroom <= Math.max(0, threshold - REARM_MARGIN);
}

export type UsageWatch = {
  id: string;
  type: UsageWatchType;
  comparison: UsageWatchComparison;
  remainingPercent: number;
  /** True: the next matching reading notifies. False: this episode was reported. */
  armed: boolean;
  lastObservedAt: string | null;
  lastHeadroomPercent: number | null;
  notifiedAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  agent_id: string;
  engine: UsageWatchType;
  comparison: UsageWatchComparison;
  threshold: string;
  armed: boolean;
  last_observed_at: Date | null;
  last_headroom: string | null;
  notified_at: Date | null;
  created_at: Date;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toWatch(row: Row): UsageWatch {
  return {
    id: row.id,
    type: row.engine,
    comparison: row.comparison,
    remainingPercent: Number(row.threshold),
    armed: row.armed,
    lastObservedAt: iso(row.last_observed_at),
    lastHeadroomPercent:
      row.last_headroom === null ? null : Number(row.last_headroom),
    notifiedAt: iso(row.notified_at),
    createdAt: row.created_at.toISOString(),
  };
}

export class UsageWatchError extends Error {}

export function describeCondition(
  comparison: UsageWatchComparison,
  threshold: number
): string {
  return `tightest-window remaining ${comparison === "at_or_below" ? "≤" : "≥"} ${threshold}%`;
}

export function noticeText(watch: UsageWatch, reading: UsageReading): string {
  const tight = reading.tightestWindow;
  return [
    `USAGE WATCH — ${watch.id}: ${watch.type} ${describeCondition(watch.comparison, watch.remainingPercent)} reached.`,
    `Remaining ${reading.headroomPercent}% in its tightest window` +
      (tight
        ? ` "${tight.label}" (${tight.id})${tight.resetsAt ? `, resets ${tight.resetsAt}` : ", no reset time reported"}`
        : "") +
      `. Observed ${reading.observedAt} (${reading.source ?? "unknown"} report)` +
      (reading.limitReached === null
        ? "."
        : `; provider limitReached: ${reading.limitReached}.`),
    `Windows: ${reading.windows.map((w) => `${w.label} ${w.remainingPercent}% remaining${w.resetsAt ? ` (resets ${w.resetsAt})` : ""}`).join("; ")}.`,
    `This is information only: nothing was launched, switched, redeemed or approved. ` +
      `The watch stays subscribed and notifies again only after usage moves ${REARM_MARGIN} points back past ${watch.remainingPercent}% and returns. ` +
      `Call get_usage for the full report, or usage_unwatch({id: "${watch.id}"}) to stop.`,
  ].join("\n");
}

export type UsageWatchDelivery = {
  signal: AbortSignal;
  beforeSubmit: () => Promise<boolean>;
};

type Deps = {
  pool: Pick<Pool, "query">;
  providerPlans: (request?: {
    force?: boolean;
  }) => Promise<ProviderPlansResponse>;
  deliver: (
    agentId: string,
    text: string,
    options: UsageWatchDelivery
  ) => Promise<void>;
  warn: (error: unknown) => void;
  now?: () => number;
  tickMs?: number;
};

export class UsageWatchService {
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<string, AbortController>();
  private deliveries = new Set<Promise<void>>();
  constructor(private readonly deps: Deps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.tick().catch(this.deps.warn);
    }, this.deps.tickMs ?? USAGE_WATCH_TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /** Settles once every delivery begun so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries]);
  }

  async subscribe(
    agentId: string,
    input: {
      type: UsageWatchType;
      comparison: UsageWatchComparison;
      remainingPercent: number;
    }
  ): Promise<{
    watch: UsageWatch;
    created: boolean;
    matched: boolean | null;
    reading: UsageReading;
  }> {
    const { type, comparison, remainingPercent } = input;
    if (!USAGE_WATCH_TYPES.includes(type))
      throw new UsageWatchError(
        `${type} does not report subscription limits; supported: ${USAGE_WATCH_TYPES.join(", ")}.`
      );
    if (!USAGE_WATCH_COMPARISONS.includes(comparison))
      throw new UsageWatchError(
        "comparison must be at_or_below or at_or_above."
      );
    if (
      !Number.isFinite(remainingPercent) ||
      remainingPercent < 0 ||
      remainingPercent > 100
    )
      throw new UsageWatchError("remainingPercent must be between 0 and 100.");
    const reading = usageReading(
      await this.deps.providerPlans(),
      type,
      this.now()
    );
    const matched =
      reading.usable && reading.headroomPercent !== null
        ? conditionMatches(
            comparison,
            remainingPercent,
            reading.headroomPercent
          )
        : null;
    const { rows: existing } = await this.deps.pool.query<Row>(
      `SELECT * FROM usage_watches WHERE agent_id = $1 AND engine = $2 AND comparison = $3 AND threshold = $4`,
      [agentId, type, comparison, remainingPercent]
    );
    if (existing[0])
      return { watch: toWatch(existing[0]), created: false, matched, reading };
    const { rows: count } = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM usage_watches WHERE agent_id = $1`,
      [agentId]
    );
    if ((count[0]?.n ?? 0) >= MAX_WATCHES_PER_AGENT)
      throw new UsageWatchError(
        `At most ${MAX_WATCHES_PER_AGENT} usage watches per agent; remove one with usage_unwatch.`
      );
    const usable = reading.usable && reading.headroomPercent !== null;
    // Already matched: this response is the episode's notice, so the watch
    // starts disarmed and notifies only after a rearm.
    const { rows } = await this.deps.pool.query<Row>(
      `INSERT INTO usage_watches (id, agent_id, engine, comparison, threshold, armed, last_observed_at, last_headroom, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $6 THEN NULL ELSE date_trunc('milliseconds', clock_timestamp()) END)
       ON CONFLICT (agent_id, engine, comparison, threshold) DO NOTHING
       RETURNING *`,
      [
        `uw_${randomBytes(6).toString("hex")}`,
        agentId,
        type,
        comparison,
        remainingPercent,
        matched !== true,
        usable ? reading.observedAt : null,
        usable ? reading.headroomPercent : null,
      ]
    );
    if (rows[0]) {
      this.start();
      return { watch: toWatch(rows[0]), created: true, matched, reading };
    }
    // Lost a race with an identical subscribe from the same agent.
    const { rows: raced } = await this.deps.pool.query<Row>(
      `SELECT * FROM usage_watches WHERE agent_id = $1 AND engine = $2 AND comparison = $3 AND threshold = $4`,
      [agentId, type, comparison, remainingPercent]
    );
    if (!raced[0])
      throw new UsageWatchError("Could not create the watch; retry.");
    return { watch: toWatch(raced[0]), created: false, matched, reading };
  }

  async list(agentId: string): Promise<UsageWatch[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT * FROM usage_watches WHERE agent_id = $1 ORDER BY created_at, id`,
      [agentId]
    );
    return rows.map(toWatch);
  }

  /** Idempotent; only the caller's own watch can be removed. */
  async unsubscribe(agentId: string, id: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `DELETE FROM usage_watches WHERE id = $1 AND agent_id = $2 RETURNING id`,
      [id, agentId]
    );
    if (rows.length) this.inFlight.get(id)?.abort();
    return rows.length > 0;
  }

  /** Background refresh: reads the shared reporter only while live watches exist. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const { rows: archived } = await this.deps.pool.query<{ id: string }>(
      `DELETE FROM usage_watches w USING agents a
        WHERE w.agent_id = a.id AND a.deleted_at IS NOT NULL RETURNING w.id`
    );
    for (const row of archived) this.inFlight.get(row.id)?.abort();
    const { rows } = await this.deps.pool.query(
      `SELECT 1 FROM usage_watches w JOIN agents a ON a.id = w.agent_id
        WHERE a.deleted_at IS NULL AND a.status = 'running' LIMIT 1`
    );
    if (!rows.length) return;
    // The reporter's cache and in-flight join decide whether this asks the
    // provider. Evaluate even a cached report: a resumed agent may be owed it.
    await this.evaluate(await this.deps.providerPlans());
  }

  /** Apply one report to every watch. Safe to call concurrently and repeatedly. */
  async evaluate(report: ProviderPlansResponse): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const type of USAGE_WATCH_TYPES) {
      const reading = usageReading(report, type, now);
      if (!reading.usable || reading.headroomPercent === null) continue;
      const params = [type, reading.observedAt, reading.headroomPercent];
      // Claim each newly matched episode atomically: a concurrent evaluation
      // of the same reading finds the row disarmed and skips it. An older
      // reading than one already applied changes nothing.
      const { rows: claimed } = await this.deps.pool.query<Row>(
        `UPDATE usage_watches w
            SET armed = false, notified_at = date_trunc('milliseconds', clock_timestamp()),
                last_observed_at = $2, last_headroom = $3
           FROM agents a
          WHERE a.id = w.agent_id AND a.status = 'running' AND a.deleted_at IS NULL
            AND w.engine = $1 AND w.armed
            AND (w.last_observed_at IS NULL OR w.last_observed_at <= $2)
            AND ((w.comparison = 'at_or_below' AND $3 <= w.threshold)
              OR (w.comparison = 'at_or_above' AND $3 >= w.threshold))
          RETURNING w.*`,
        params
      );
      await this.deps.pool.query(
        `UPDATE usage_watches
            SET armed = true, last_observed_at = $2, last_headroom = $3
          WHERE engine = $1 AND NOT armed
            AND (last_observed_at IS NULL OR last_observed_at <= $2)
            AND ((comparison = 'at_or_below' AND $3 > threshold AND $3 >= LEAST(threshold + $4, 100))
              OR (comparison = 'at_or_above' AND $3 < threshold AND $3 <= GREATEST(threshold - $4, 0)))`,
        [...params, REARM_MARGIN]
      );
      await this.deps.pool.query(
        `UPDATE usage_watches SET last_observed_at = $2, last_headroom = $3
          WHERE engine = $1 AND (last_observed_at IS NULL OR last_observed_at < $2)`,
        params
      );
      for (const row of claimed) this.track(this.notify(row, reading));
    }
  }

  private track(delivery: Promise<void>) {
    this.deliveries.add(delivery);
    void delivery.finally(() => this.deliveries.delete(delivery));
  }

  private async notify(row: Row, reading: UsageReading): Promise<void> {
    const watch = toWatch(row);
    this.inFlight.get(watch.id)?.abort();
    const controller = new AbortController();
    this.inFlight.set(watch.id, controller);
    let accepted = false;
    try {
      await this.deps.deliver(row.agent_id, noticeText(watch, reading), {
        signal: controller.signal,
        // Acceptance re-checks the episode, not the earlier snapshot: an
        // unsubscribe, archive or rearm while queued drops the notice.
        beforeSubmit: async () => {
          if (controller.signal.aborted) return false;
          const { rows } = await this.deps.pool.query(
            `SELECT 1 FROM usage_watches w JOIN agents a ON a.id = w.agent_id
              WHERE w.id = $1 AND w.agent_id = $2 AND NOT w.armed AND w.notified_at = $3
                AND a.status = 'running' AND a.deleted_at IS NULL`,
            [row.id, row.agent_id, row.notified_at]
          );
          accepted = rows.length > 0;
          return accepted;
        },
      });
    } catch (error) {
      if (!accepted && !controller.signal.aborted) {
        // Not delivered (host unavailable, agent stopped): rearm the same
        // episode so a later evaluation retries while it still matches.
        await this.deps.pool
          .query(
            `UPDATE usage_watches SET armed = true, notified_at = NULL
              WHERE id = $1 AND NOT armed AND notified_at = $2`,
            [row.id, row.notified_at]
          )
          .catch(this.deps.warn);
        this.deps.warn(error);
      }
    } finally {
      if (this.inFlight.get(watch.id) === controller)
        this.inFlight.delete(watch.id);
    }
  }
}
