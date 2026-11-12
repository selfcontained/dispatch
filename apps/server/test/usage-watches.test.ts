import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import type { ProviderPlan, ProviderPlansResponse } from "@dispatch/shared";

import {
  REARM_MARGIN,
  STALE_AFTER_MS,
  UsageWatchService,
  conditionMatches,
  conditionRearms,
  usageReading,
} from "../src/agents/usage-watches.js";
import { createProviderPlansReporter } from "../src/agents/provider-plans.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
let clock = NOW;
let observed = 0;

/** A fresh observation each call, so readings are ordered like real refreshes. */
function plan(
  engine: "claude" | "codex",
  used: number[],
  extra: Partial<ProviderPlan> = {}
): ProviderPlan {
  observed += 1;
  return {
    engine,
    plan: "Max",
    observedAt: new Date(clock - 60_000 + observed).toISOString(),
    source: "live",
    windows: used.map((usedPercent, i) => ({
      id: `w${i}`,
      label: i === 0 ? "5-hour" : "weekly",
      usedPercent,
      resetsAt: "2026-11-11T15:00:00Z",
    })),
    ...extra,
  };
}

const report = (...providers: ProviderPlan[]): ProviderPlansResponse => ({
  checkedAt: new Date(clock).toISOString(),
  providers,
});

describe("usageReading", () => {
  it("uses the tightest window's remaining percent, like get_usage", () => {
    const reading = usageReading(report(plan("codex", [30, 95])), "codex", NOW);
    expect(reading).toMatchObject({
      usable: true,
      headroomPercent: 5,
      tightestWindow: { id: "w1", label: "weekly", remainingPercent: 5 },
      source: "live",
    });
    expect(reading.windows).toHaveLength(2);
  });

  it("never treats missing, windowless, undated or stale reports as a value", () => {
    expect(usageReading(report(), "claude", NOW)).toMatchObject({
      usable: false,
      headroomPercent: null,
    });
    expect(
      usageReading(
        report(plan("claude", [], { unavailableReason: "not signed in" })),
        "claude",
        NOW
      )
    ).toMatchObject({ usable: false, reason: "not signed in" });
    expect(
      usageReading(
        report(plan("claude", [50], { observedAt: null })),
        "claude",
        NOW
      ).usable
    ).toBe(false);
    const stale = plan("claude", [99], {
      observedAt: new Date(NOW - STALE_AFTER_MS - 1).toISOString(),
    });
    const reading = usageReading(report(stale), "claude", NOW);
    expect(reading.usable).toBe(false);
    expect(reading.headroomPercent).toBe(1);
  });

  it("does not expose credit identifiers", () => {
    const reading = usageReading(
      report(
        plan("codex", [10], {
          limitResets: {
            available: 1,
            applicable: 1,
            items: [
              { id: "secret", title: "t", grantedAt: null, expiresAt: null },
            ],
          },
        })
      ),
      "codex",
      NOW
    );
    expect(JSON.stringify(reading)).not.toContain("secret");
  });
});

describe("predicates", () => {
  it("matches equality for both comparisons", () => {
    expect(conditionMatches("at_or_below", 10, 10)).toBe(true);
    expect(conditionMatches("at_or_below", 10, 10.5)).toBe(false);
    expect(conditionMatches("at_or_above", 80, 80)).toBe(true);
    expect(conditionMatches("at_or_above", 80, 79.9)).toBe(false);
  });

  it("rearms only past the hysteresis margin, clamped to 0..100", () => {
    expect(conditionRearms("at_or_below", 10, 10 + REARM_MARGIN - 1)).toBe(
      false
    );
    expect(conditionRearms("at_or_below", 10, 10 + REARM_MARGIN)).toBe(true);
    expect(conditionRearms("at_or_below", 98, 100)).toBe(true);
    expect(conditionRearms("at_or_below", 100, 100)).toBe(false);
    expect(conditionRearms("at_or_above", 80, 76)).toBe(false);
    expect(conditionRearms("at_or_above", 80, 75)).toBe(true);
    expect(conditionRearms("at_or_above", 2, 0)).toBe(true);
    expect(conditionRearms("at_or_above", 0, 0)).toBe(false);
  });
});

describe("provider plans reporter onReport", () => {
  it("notifies listeners of each load, isolates failures and unsubscribes", async () => {
    const fetchUsage = vi.fn(async () => new Response("{}", { status: 401 }));
    const reporter = createProviderPlansReporter(
      {
        homeDir: "/nobody",
        env: {},
        platform: "linux",
        read: async () => {
          throw new Error("none");
        },
        fetchUsage: fetchUsage as unknown as typeof fetch,
        codexFiles: async () => [],
      },
      0
    );
    const listener = vi.fn();
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const stop = reporter.onReport(listener);
    reporter.onReport(failing);
    const first = await reporter();
    expect(listener).toHaveBeenCalledWith(first);
    stop();
    await reporter();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("UsageWatchService (postgres)", () => {
  let pool: Pool;
  let current: ProviderPlansResponse;
  const deliver = vi.fn();
  let service: UsageWatchService;

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    clock = NOW;
    await pool.query("DELETE FROM usage_watches");
    await pool.query("DELETE FROM agents WHERE id LIKE 'agt_uw_%'");
    for (const id of ["agt_uw_a", "agt_uw_b"])
      await pool.query(
        `INSERT INTO agents (id, name, cwd, status) VALUES ($1, $1, '/tmp', 'running')`,
        [id]
      );
    current = report(plan("claude", [50]), plan("codex", [50]));
    deliver.mockReset().mockImplementation(async (_agent, _text, options) => {
      if (!(await options.beforeSubmit())) throw new Error("cancelled");
    });
    service = new UsageWatchService({
      pool,
      providerPlans: async () => current,
      deliver,
      warn: () => {},
      now: () => clock,
    });
  });
  afterEach(() => service.dispose());

  const feed = async (...providers: ProviderPlan[]) => {
    current = report(...providers);
    await service.evaluate(current);
    await service.idle();
  };

  it("validates type, comparison and range", async () => {
    await expect(
      service.subscribe("agt_uw_a", {
        type: "opencode" as never,
        comparison: "at_or_below",
        remainingPercent: 10,
      })
    ).rejects.toThrow(/does not report/);
    await expect(
      service.subscribe("agt_uw_a", {
        type: "claude",
        comparison: "below" as never,
        remainingPercent: 10,
      })
    ).rejects.toThrow(/comparison/);
    for (const bad of [-1, 101, Number.NaN])
      await expect(
        service.subscribe("agt_uw_a", {
          type: "claude",
          comparison: "at_or_below",
          remainingPercent: bad,
        })
      ).rejects.toThrow(/between 0 and 100/);
  });

  it("notifies once per episode, ignores noise, rearms past the margin", async () => {
    const sub = await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    expect(sub).toMatchObject({
      created: true,
      matched: false,
      watch: { armed: true },
    });
    await feed(plan("codex", [80])); // 20% remaining
    expect(deliver).not.toHaveBeenCalled();
    await feed(plan("codex", [90])); // exactly 10%: equality matches
    expect(deliver).toHaveBeenCalledTimes(1);
    const [agentId, text] = deliver.mock.calls[0]!;
    expect(agentId).toBe("agt_uw_a");
    expect(text).toContain(`USAGE WATCH — ${sub.watch.id}`);
    expect(text).toContain("Remaining 10%");
    expect(text).toContain("resets 2026-11-11T15:00:00Z");
    expect(text).toContain("information only");
    await feed(plan("codex", [92]));
    await feed(plan("codex", [88])); // 12%: noisy, under margin
    await feed(plan("codex", [91]));
    expect(deliver).toHaveBeenCalledTimes(1);
    await feed(plan("codex", [0])); // quota reset → 100% remaining rearms
    expect((await service.list("agt_uw_a"))[0]).toMatchObject({
      armed: true,
      lastHeadroomPercent: 100,
    });
    await feed(plan("codex", [95]));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("already matched at subscribe: the response is the notice; disarmed", async () => {
    current = report(plan("claude", [97]));
    const sub = await service.subscribe("agt_uw_a", {
      type: "claude",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    expect(sub).toMatchObject({
      matched: true,
      watch: { armed: false },
      reading: { headroomPercent: 3 },
    });
    await feed(plan("claude", [98]));
    expect(deliver).not.toHaveBeenCalled();
  });

  it("recovery watchers fire at_or_above, including after a reset", async () => {
    current = report(plan("claude", [100]));
    await service.subscribe("agt_uw_a", {
      type: "claude",
      comparison: "at_or_above",
      remainingPercent: 50,
    });
    await feed(plan("claude", [60]));
    expect(deliver).not.toHaveBeenCalled();
    await feed(plan("claude", [0]));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![1]).toContain("remaining ≥ 50%");
  });

  it("unknown or stale readings neither match nor rearm", async () => {
    await service.subscribe("agt_uw_a", {
      type: "claude",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    await feed(plan("claude", [], { unavailableReason: "login expired" }));
    await feed(
      plan("claude", [100], {
        observedAt: new Date(clock - STALE_AFTER_MS - 1000).toISOString(),
      })
    );
    await feed();
    expect(deliver).not.toHaveBeenCalled();
    expect((await service.list("agt_uw_a"))[0]).toMatchObject({
      armed: true,
      lastHeadroomPercent: 50,
    });
  });

  it("selects providers independently and ignores out-of-order readings", async () => {
    await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    const older = plan("codex", [99]);
    await feed(plan("claude", [99]), plan("codex", [40]));
    expect(deliver).not.toHaveBeenCalled();
    await feed(older); // observed before the 60% reading already applied
    expect(deliver).not.toHaveBeenCalled();
  });

  it("concurrent evaluations of one reading deliver once", async () => {
    await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    current = report(plan("codex", [95]));
    await Promise.all([
      service.evaluate(current),
      service.evaluate(current),
      service.evaluate(current),
    ]);
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("binds watches to the caller: list and unsubscribe are isolated and idempotent", async () => {
    const a = await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    const again = await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    expect(again).toMatchObject({ created: false, watch: { id: a.watch.id } });
    await service.subscribe("agt_uw_b", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    expect(await service.list("agt_uw_a")).toHaveLength(1);
    expect(await service.unsubscribe("agt_uw_b", a.watch.id)).toBe(false);
    expect(await service.list("agt_uw_a")).toHaveLength(1);
    expect(await service.unsubscribe("agt_uw_a", a.watch.id)).toBe(true);
    expect(await service.unsubscribe("agt_uw_a", a.watch.id)).toBe(false);
    await feed(plan("codex", [95]));
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(["agt_uw_b"]);
  });

  /** A delivery held at a gate, recording what the runtime would have done. */
  function gatedDeliveries() {
    const outcomes: Array<"aborted" | "declined" | "submitted"> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const impl = async (
      _agent: string,
      _text: string,
      options: { signal: AbortSignal; beforeSubmit: () => Promise<boolean> }
    ) => {
      await gate;
      if (options.signal.aborted) {
        outcomes.push("aborted");
        throw new Error("cancelled");
      }
      if (!(await options.beforeSubmit())) {
        outcomes.push("declined");
        throw new Error("cancelled");
      }
      outcomes.push("submitted");
    };
    return { outcomes, release: () => release(), impl };
  }
  const watchCodexLow = (agent = "agt_uw_a") =>
    service.subscribe(agent, {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });

  it("unsubscribe while a notice is queued aborts it", async () => {
    const sub = await watchCodexLow();
    const gated = gatedDeliveries();
    deliver.mockImplementation(gated.impl);
    current = report(plan("codex", [95]));
    await service.evaluate(current);
    expect(await service.unsubscribe("agt_uw_a", sub.watch.id)).toBe(true);
    gated.release();
    await service.idle();
    expect(gated.outcomes).toEqual(["aborted"]);
  });

  it("a queued notice is not accepted for a resubscribed watch (DB check, no abort)", async () => {
    await watchCodexLow();
    const gated = gatedDeliveries();
    deliver.mockImplementation(gated.impl);
    current = report(plan("codex", [95]));
    await service.evaluate(current);
    // Bypass the in-memory abort: delete and resubscribe straight in the DB.
    await pool.query(`DELETE FROM usage_watches WHERE agent_id = 'agt_uw_a'`);
    const other = new UsageWatchService({
      pool,
      providerPlans: async () => current,
      deliver: async () => {},
      warn: () => {},
      now: () => clock,
    });
    const again = await other.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    expect(again).toMatchObject({ created: true, matched: true });
    gated.release();
    await service.idle();
    other.dispose();
    expect(gated.outcomes).toEqual(["declined"]);
  });

  it("notified_at identifies the episode: only the newest claim is accepted", async () => {
    await watchCodexLow();
    const gated = gatedDeliveries();
    deliver.mockImplementation(gated.impl);
    await service.evaluate((current = report(plan("codex", [95]))));
    // A second process (empty in-flight map) rearms and reclaims the watch.
    const otherDeliver = vi.fn(
      async (
        _a: string,
        _t: string,
        o: { beforeSubmit: () => Promise<boolean> }
      ) => {
        if (!(await o.beforeSubmit())) throw new Error("cancelled");
      }
    );
    const other = new UsageWatchService({
      pool,
      providerPlans: async () => current,
      deliver: otherDeliver,
      warn: () => {},
      now: () => clock,
    });
    await other.evaluate(report(plan("codex", [0])));
    await other.evaluate(report(plan("codex", [96])));
    await other.idle();
    gated.release();
    await service.idle();
    other.dispose();
    expect(gated.outcomes).toEqual(["declined"]);
    expect(otherDeliver).toHaveBeenCalledTimes(1);
    const [watch] = await service.list("agt_uw_a");
    expect(watch).toMatchObject({ armed: false, lastHeadroomPercent: 4 });
    expect(watch!.notifiedAt).not.toBeNull();
  });

  it("a notice declined because the agent stopped while queued is rearmed", async () => {
    await watchCodexLow();
    const gated = gatedDeliveries();
    deliver.mockImplementation(gated.impl);
    await service.evaluate((current = report(plan("codex", [95]))));
    await pool.query(
      `UPDATE agents SET status = 'stopped' WHERE id = 'agt_uw_a'`
    );
    gated.release();
    await service.idle();
    expect(gated.outcomes).toEqual(["declined"]);
    expect((await service.list("agt_uw_a"))[0]).toMatchObject({
      armed: true,
      notifiedAt: null,
    });
  });

  it("a prompt that fails after the pre-submit check passed is rearmed", async () => {
    await watchCodexLow();
    deliver.mockImplementationOnce(async (_a, _t, options) => {
      expect(await options.beforeSubmit()).toBe(true);
      throw new Error("host exited mid-submit");
    });
    await feed(plan("codex", [95]));
    expect((await service.list("agt_uw_a"))[0]).toMatchObject({
      armed: true,
      notifiedAt: null,
    });
  });

  it("a claim lost to shutdown is rearmed at the next boot", async () => {
    await watchCodexLow();
    const gated = gatedDeliveries();
    deliver.mockImplementation(gated.impl);
    await service.evaluate((current = report(plan("codex", [95]))));
    service.dispose();
    gated.release();
    await service.idle();
    expect(gated.outcomes).toEqual(["aborted"]);
    expect((await service.list("agt_uw_a"))[0]!.armed).toBe(false);
    deliver.mockReset().mockImplementation(async (_a, _t, options) => {
      if (!(await options.beforeSubmit())) throw new Error("cancelled");
    });
    service = new UsageWatchService({
      pool,
      providerPlans: async () => current,
      deliver,
      warn: () => {},
      now: () => clock,
    });
    await service.recover();
    await service.tick();
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
    // Delivered episodes are not re-sent by a later boot.
    await service.recover();
    await service.tick();
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("a stopped agent keeps its watch armed and gets the notice after resuming", async () => {
    await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    await pool.query(
      `UPDATE agents SET status = 'stopped' WHERE id = 'agt_uw_a'`
    );
    await feed(plan("codex", [95]));
    expect(deliver).not.toHaveBeenCalled();
    expect((await service.list("agt_uw_a"))[0]!.armed).toBe(true);
    await pool.query(
      `UPDATE agents SET status = 'running' WHERE id = 'agt_uw_a'`
    );
    await service.tick(); // same cached reading
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("a failed delivery rearms and retries no sooner than one tick later", async () => {
    await watchCodexLow();
    deliver.mockRejectedValueOnce(new Error("Agent has no live session"));
    await feed(plan("codex", [95]));
    expect((await service.list("agt_uw_a"))[0]).toMatchObject({
      armed: true,
      notifiedAt: null,
    });
    // Same cached report, repeatedly: backing off, no re-delivery.
    await service.evaluate(current);
    await service.tick();
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000 + 1;
    await service.tick();
    await service.idle();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await service.list("agt_uw_a"))[0]!.armed).toBe(false);
  });

  it("archived agents lose their watches; tick skips the provider without live watches", async () => {
    const providerPlans = vi.fn(async () => current);
    service.dispose();
    service = new UsageWatchService({
      pool,
      providerPlans,
      deliver,
      warn: () => {},
      now: () => clock,
    });
    await service.tick();
    expect(providerPlans).not.toHaveBeenCalled();
    await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    await pool.query(
      `UPDATE agents SET deleted_at = now() WHERE id = 'agt_uw_a'`
    );
    providerPlans.mockClear();
    await service.tick();
    expect(providerPlans).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      `SELECT 1 FROM usage_watches WHERE agent_id = 'agt_uw_a'`
    );
    expect(rows).toEqual([]);
  });

  it("state survives a service (server) restart without duplicate notices", async () => {
    await service.subscribe("agt_uw_a", {
      type: "codex",
      comparison: "at_or_below",
      remainingPercent: 10,
    });
    await feed(plan("codex", [95]));
    expect(deliver).toHaveBeenCalledTimes(1);
    service.dispose();
    service = new UsageWatchService({
      pool,
      providerPlans: async () => current,
      deliver,
      warn: () => {},
      now: () => clock,
    });
    await service.tick();
    await service.idle();
    await feed(plan("codex", [96]));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
