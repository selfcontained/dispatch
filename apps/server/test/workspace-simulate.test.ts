import { stat } from "node:fs/promises";
import os from "node:os";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/git/worktree.js", () => ({
  createGitWorktree: vi.fn(),
}));

const { prepareWorkspace } = await import("../src/agents/workspace.js");
const { createGitWorktree } = await import("../src/shared/git/worktree.js");

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

describe("simulated workspace", () => {
  it("walks the worktree phases without touching git", async () => {
    const phases: string[] = [];
    const workspace = await prepareWorkspace(
      {
        agentName: "sim",
        originalCwd: "/repo/dispatch",
        useWorktree: true,
        createNewBranch: true,
        worktreeBranchName: "agt_x/some branch",
        baseBranch: undefined,
        worktreePathOverride: undefined,
        onPhase: async (phase) => {
          phases.push(phase);
        },
        simulateMs: 0,
      },
      logger
    );
    expect(phases).toEqual(["worktree", "deps", "session"]);
    expect(createGitWorktree).not.toHaveBeenCalled();
    // A worktree-shaped directory that exists, and is not recorded as a
    // worktree, so archiving never goes looking for a branch to remove.
    expect(workspace.effectiveCwd.startsWith(os.tmpdir())).toBe(true);
    expect(workspace.effectiveCwd).toMatch(
      /dispatch\/\.dispatch\/worktrees\/agt_x-some-branch$/
    );
    expect((await stat(workspace.effectiveCwd)).isDirectory()).toBe(true);
    expect(workspace.worktreePath).toBeNull();
    expect(workspace.worktreeBranch).toBeNull();
  });

  it("goes straight to the session without a worktree", async () => {
    const phases: string[] = [];
    const workspace = await prepareWorkspace(
      {
        agentName: "sim",
        originalCwd: "/repo/dispatch",
        useWorktree: false,
        createNewBranch: false,
        worktreeBranchName: undefined,
        baseBranch: undefined,
        worktreePathOverride: undefined,
        onPhase: async (phase) => {
          phases.push(phase);
        },
        simulateMs: 0,
      },
      logger
    );
    expect(phases).toEqual(["session"]);
    expect(workspace.effectiveCwd).toBe("/repo/dispatch");
  });
});
