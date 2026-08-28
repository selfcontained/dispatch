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
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
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

  it("caps the traversal in SQL without a blocking DISTINCT", async () => {
    const { manager, query } = makeManager([]);
    await manager.checkSubtreeWorktreeStatus("root");

    const sql = String(query.mock.calls[0]?.[0]);
    // DISTINCT would force the whole recursion to be consumed before LIMIT
    // could apply — the opposite of bounding the work. One parent per agent
    // makes the walk a tree, so ids cannot repeat and it is not needed.
    expect(sql).not.toContain("DISTINCT");
    expect(sql).toContain("LIMIT $2");
    // One over the node cap, so an oversized traversal is detectable.
    expect(query.mock.calls[0]?.[1]).toEqual(["root", 5001]);
  });

  it("marks the preview incomplete when the traversal hits the node cap", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      id: `a${i}`,
      name: `a${i}`,
      worktree_path: null,
    }));
    const { manager } = makeManager(rows);

    const result = await manager.checkSubtreeWorktreeStatus("a0");

    // Nothing to show, but the walk was cut short — saying so keeps the caller
    // from reading an empty list as "nothing to lose".
    expect(result.complete).toBe(false);
    expect(result.statuses).toEqual([]);
  });

  it("refuses rather than piling up concurrent git work", async () => {
    const rows = [{ id: "root", name: "root", worktree_path: "/wt/root" }];
    const release: Array<() => void> = [];
    // Three reads held open on purpose, then released — no timers involved, so
    // the gate's own bookkeeping is what the assertions exercise.
    for (let i = 0; i < 3; i += 1) {
      vi.mocked(readWorktreeStatus).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release.push(() =>
              resolve({
                hasWorktree: true,
                hasUnmergedCommits: false,
                hasUncommittedChanges: false,
                worktreePath: "/wt/root",
                branchName: "agt/x",
                changedFiles: [],
                uncommittedFiles: [],
              })
            );
          })
      );
    }

    const managers = Array.from({ length: 4 }, () => makeManager(rows).manager);
    const pending = managers
      .slice(0, 3)
      .map((m) => m.checkSubtreeWorktreeStatus("root"));
    await vi.waitFor(() => expect(release).toHaveLength(3));

    // Detached reads outlive their request, so admission control is what
    // actually bounds the git load.
    const refused = await managers[3]!.checkSubtreeWorktreeStatus("root");
    expect(refused).toEqual({ statuses: [], complete: false });

    release.forEach((fn) => fn());
    await Promise.all(pending);

    // The gate reopens once they finish.
    const afterDrain = await managers[3]!.checkSubtreeWorktreeStatus("root");
    expect(afterDrain.complete).toBe(true);
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
