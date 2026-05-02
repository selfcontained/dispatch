import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DiffStatsRefresher,
  type DiffStatsAgent,
  type DiffStatsChangedEvent,
} from "../src/agents/diff-stats-refresher.js";
import type { DiffStats } from "../src/shared/git/diff-stats.js";

type AgentMap = Map<string, DiffStatsAgent>;

function setupAgents(entries: Array<[string, DiffStatsAgent]>): AgentMap {
  return new Map(entries);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-02T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DiffStatsRefresher", () => {
  it("publishes a change event when stats first arrive", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const events: DiffStatsChangedEvent[] = [];
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
      freshnessMs: 3_000,
    });

    await refresher.signal("a1");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: "agent.diff_state_changed",
        agentId: "a1",
        diffStats: expect.objectContaining({ added: 5, deleted: 1, files: 2 }),
      }),
    ]);
    expect(refresher.getStats("a1")).toMatchObject({
      added: 5,
      deleted: 1,
      files: 2,
    });
  });

  it("treats a second signal within the freshness window as a no-op", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
      freshnessMs: 3_000,
    });

    await refresher.signal("a1");
    vi.setSystemTime(new Date("2026-05-02T00:00:01Z")); // 1s later
    await refresher.signal("a1");

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the freshness window has passed", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
      freshnessMs: 3_000,
    });

    await refresher.signal("a1");
    vi.setSystemTime(new Date("2026-05-02T00:00:04Z")); // 4s later
    await refresher.signal("a1");

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("does not republish when stats are unchanged", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const events: DiffStatsChangedEvent[] = [];
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
      freshnessMs: 1_000,
    });

    await refresher.signal("a1");
    vi.setSystemTime(new Date("2026-05-02T00:00:02Z"));
    await refresher.signal("a1");

    expect(events).toHaveLength(1);
  });

  it("publishes again when stats actually change", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const events: DiffStatsChangedEvent[] = [];
    let call = 0;
    const compute = vi.fn(async (): Promise<DiffStats> => {
      call += 1;
      return {
        added: call === 1 ? 5 : 12,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      };
    });
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
      freshnessMs: 1_000,
    });

    await refresher.signal("a1");
    vi.setSystemTime(new Date("2026-05-02T00:00:02Z"));
    await refresher.signal("a1");

    expect(events).toHaveLength(2);
    expect(events[1].diffStats).toMatchObject({ added: 12 });
  });

  it("dedupes simultaneous signals via the in-flight promise", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    let resolveCompute: ((value: DiffStats) => void) | null = null;
    const compute = vi.fn(
      () =>
        new Promise<DiffStats>((resolve) => {
          resolveCompute = resolve;
        })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
      freshnessMs: 3_000,
    });

    const a = refresher.signal("a1");
    const b = refresher.signal("a1");
    const c = refresher.signal("a1");

    // Let getAgent resolve so refresh() reaches the compute call.
    await Promise.resolve();
    await Promise.resolve();

    expect(compute).toHaveBeenCalledTimes(1);
    resolveCompute?.({
      added: 1,
      deleted: 0,
      files: 1,
      computedAt: Date.now(),
    });
    await Promise.all([a, b, c]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("publishes null and clears state when worktreePath is missing", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const events: DiffStatsChangedEvent[] = [];
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
      freshnessMs: 1_000,
    });

    await refresher.signal("a1");
    expect(events).toHaveLength(1);

    agents.set("a1", { worktreePath: null, cwd: null, baseBranch: null });
    vi.setSystemTime(new Date("2026-05-02T00:00:02Z"));
    await refresher.signal("a1");

    expect(events).toHaveLength(2);
    expect(events[1].diffStats).toBeNull();
    expect(refresher.getStats("a1")).toBeNull();
  });

  it("clear() drops the cached value and re-allows immediate signals", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 5,
        deleted: 1,
        files: 2,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
      freshnessMs: 3_000,
    });

    await refresher.signal("a1");
    expect(refresher.getStats("a1")).not.toBeNull();
    refresher.clear("a1");
    expect(refresher.getStats("a1")).toBeNull();
    // freshness gate is keyed off lastSignaledAt, which clear() resets,
    // so the next signal recomputes immediately.
    await refresher.signal("a1");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("falls back to agent.cwd when worktreePath is null", async () => {
    // Agents created with useWorktree=false have no dispatch-managed
    // worktreePath, but their cwd may still be inside a git repo —
    // compute against that path so any git working tree gets stats.
    const agents = setupAgents([
      ["a1", { worktreePath: null, cwd: "/some/repo", baseBranch: "main" }],
    ]);
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 7,
        deleted: 0,
        files: 1,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
    });

    await refresher.signal("a1");
    expect(compute).toHaveBeenCalledWith("/some/repo", "main");
  });

  it("publishes null when both worktreePath and cwd are missing", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: null, cwd: null, baseBranch: null }],
    ]);
    const compute = vi.fn();
    const events: DiffStatsChangedEvent[] = [];
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
    });

    await refresher.signal("a1");
    expect(compute).not.toHaveBeenCalled();
    // Cache primes to null on the first signal but no event fires for the
    // null→null transition; verify state directly.
    expect(refresher.getStats("a1")).toBeNull();
  });

  it("passes agent.baseBranch through to the compute callback", async () => {
    // The refresher no longer applies its own base-ref fallback — that
    // policy lives in the shared resolver inside getDiffStats. Confirm
    // we forward agent.baseBranch (including null) verbatim.
    const agents = setupAgents([
      [
        "with-base",
        { worktreePath: "/tmp/wt", cwd: null, baseBranch: "trunk" },
      ],
      ["no-base", { worktreePath: "/tmp/wt", cwd: null, baseBranch: null }],
    ]);
    const compute = vi.fn(
      async (): Promise<DiffStats> => ({
        added: 0,
        deleted: 0,
        files: 0,
        computedAt: Date.now(),
      })
    );
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: () => {},
      computeDiffStats: compute,
    });

    await refresher.signal("with-base");
    expect(compute).toHaveBeenCalledWith("/tmp/wt", "trunk");

    await refresher.signal("no-base");
    expect(compute).toHaveBeenCalledWith("/tmp/wt", null);
  });

  it("swallows compute errors and leaves the cache unchanged", async () => {
    const agents = setupAgents([
      ["a1", { worktreePath: "/tmp/wt", cwd: null, baseBranch: "main" }],
    ]);
    const events: DiffStatsChangedEvent[] = [];
    const initial: DiffStats = {
      added: 5,
      deleted: 1,
      files: 2,
      computedAt: Date.now(),
    };
    let call = 0;
    const compute = vi.fn(async () => {
      call += 1;
      if (call === 1) return initial;
      throw new Error("git exploded");
    });
    const warn = vi.fn();
    const refresher = new DiffStatsRefresher({
      getAgent: async (id) => agents.get(id) ?? null,
      publishEvent: (event) => events.push(event),
      computeDiffStats: compute,
      freshnessMs: 1_000,
      logger: { warn },
    });

    await refresher.signal("a1");
    expect(refresher.getStats("a1")).toMatchObject({ added: 5 });

    vi.setSystemTime(new Date("2026-05-02T00:00:02Z"));
    await refresher.signal("a1");

    expect(refresher.getStats("a1")).toMatchObject({ added: 5 });
    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});
