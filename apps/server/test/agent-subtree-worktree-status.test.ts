import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/git/worktree-status.js", () => ({
  readWorktreeStatus: vi.fn(async (worktreePath: string) => ({
    hasWorktree: true,
    hasUnmergedCommits: false,
    hasUncommittedChanges: worktreePath.includes("dirty"),
    worktreePath,
    branchName: "agt/x",
    changedFiles: [],
    uncommittedFiles: worktreePath.includes("dirty") ? ["wip.ts"] : [],
  })),
}));

import { AgentManager } from "../src/agents/manager.js";
import { readWorktreeStatus } from "../src/shared/git/worktree-status.js";

type Row = { id: string; name: string; worktree_path: string | null };

/**
 * Runs the manager's real subtree SQL against a fake pool, so the assertions
 * are about the query the archive preview actually issues.
 */
function makeManager(rows: Row[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  Object.assign(manager, {
    pool: { query },
    getRequiredAgent: vi.fn(async (id: string) => ({ id })),
  });
  return { manager, query };
}

describe("checkSubtreeWorktreeStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks the whole tree rather than capping its depth", async () => {
    // The cascade has no depth limit, so a preview that capped would hide a
    // deep descendant's worktree that a force cleanup still deletes.
    const { manager, query } = makeManager([]);
    await manager.checkSubtreeWorktreeStatus("root");

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/depth\s*<\s*\d+/);
    // Cycles are stopped by the visited path instead.
    expect(sql).toContain("ANY(s.path)");
  });

  it("skips agents their own archive already owns", async () => {
    const { manager, query } = makeManager([]);
    await manager.checkSubtreeWorktreeStatus("root");

    // Matches getChildAgentIds: an archiving agent is not swept by this
    // cascade, so listing its worktree would misdescribe what force removes.
    expect(String(query.mock.calls[0]?.[0])).toContain("status <> 'archiving'");
  });

  it("bounds the query itself rather than filtering in memory", async () => {
    const { manager, query } = makeManager([]);
    await manager.checkSubtreeWorktreeStatus("root");

    // A large subtree must never materialize here just to be sliced.
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("worktree_path IS NOT NULL");
    expect(sql).toContain("LIMIT $2");
    // One over the cap, so an oversized subtree is detectable.
    expect(query.mock.calls[0]?.[1]).toEqual(["root", 51]);
  });

  it("marks the preview incomplete when a status read outruns the budget", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(readWorktreeStatus).mockImplementationOnce(
        () => new Promise(() => {}) as never
      );
      const { manager } = makeManager([
        { id: "root", name: "root", worktree_path: "/wt/root" },
      ]);

      const pending = manager.checkSubtreeWorktreeStatus("root");
      await vi.advanceTimersByTimeAsync(21_000);
      const result = await pending;

      // git cannot be aborted, so the read is abandoned rather than awaited —
      // and the preview says so instead of looking clean.
      expect(result.complete).toBe(false);
      expect(result.statuses).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports only agents that actually have a worktree, target first", async () => {
    const { manager } = makeManager([
      { id: "root", name: "root", worktree_path: "/wt/root" },
      { id: "child", name: "a-child", worktree_path: "/wt/dirty-child" },
    ]);

    const result = await manager.checkSubtreeWorktreeStatus("root");

    expect(result.complete).toBe(true);
    expect(result.statuses.map((s) => s.agentId)).toEqual(["root", "child"]);
    expect(result.statuses[0]?.isTarget).toBe(true);
    expect(result.statuses[1]?.hasUncommittedChanges).toBe(true);
  });

  it("marks the preview incomplete when the subtree exceeds the budget", async () => {
    // 51 rows: the query asks for one over the cap precisely so this is visible.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `a${i}`,
      name: `a${i}`,
      worktree_path: `/wt/a${i}`,
    }));
    const { manager } = makeManager(rows);

    const result = await manager.checkSubtreeWorktreeStatus("a0");

    // A short list that reads as "nothing to lose" would be worse than saying
    // the check did not finish.
    expect(result.complete).toBe(false);
    expect(result.statuses).toHaveLength(50);
    expect(readWorktreeStatus).toHaveBeenCalledTimes(50);
  });
});
