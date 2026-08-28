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

  it("reports only agents that actually have a worktree, target first", async () => {
    const { manager } = makeManager([
      { id: "root", name: "root", worktree_path: "/wt/root" },
      { id: "no-wt", name: "no-wt", worktree_path: null },
      { id: "child", name: "a-child", worktree_path: "/wt/dirty-child" },
    ]);

    const result = await manager.checkSubtreeWorktreeStatus("root");

    expect(result.complete).toBe(true);
    expect(result.statuses.map((s) => s.agentId)).toEqual(["root", "child"]);
    expect(result.statuses[0]?.isTarget).toBe(true);
    expect(result.statuses[1]?.hasUncommittedChanges).toBe(true);
  });

  it("marks the preview incomplete when the subtree exceeds the budget", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
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
