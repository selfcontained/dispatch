import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dispatch/shared/lib/run-command.js", () => ({
  runCommand: vi.fn()
}));

const { createGitWorktree, cleanupGitWorktree, GitWorktreeError } = await import("@dispatch/shared/git/worktree.js");
const { runCommand } = await import("@dispatch/shared/lib/run-command.js");

describe("git worktree services", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-worktree-test-"));
    vi.mocked(runCommand).mockReset();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates a linked worktree from origin/main", async () => {
    const repoRoot = path.join(tempRoot, "repo");
    const expectedWorktreePath = path.join(tempRoot, "repo-feature-auth-flow");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
        case `-C ${path.join(repoRoot, "nested")} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} fetch origin main --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-parse --verify origin/main`:
          return { exitCode: 0, stdout: "abc123", stderr: "" };
        case `-C ${repoRoot} show-ref --verify --quiet refs/heads/feature-auth-flow`:
        case `-C ${repoRoot} show-ref --verify --quiet refs/remotes/origin/feature-auth-flow`:
          return { exitCode: 1, stdout: "", stderr: "" };
        case `-C ${repoRoot} worktree add -b feature-auth-flow ${expectedWorktreePath} origin/main`:
        case `-C ${expectedWorktreePath} branch --set-upstream-to origin/main feature-auth-flow`:
          return { exitCode: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await createGitWorktree({
      cwd: path.join(repoRoot, "nested"),
      name: "Feature Auth Flow"
    });

    expect(result).toEqual({
      repoRoot,
      worktreePath: expectedWorktreePath,
      worktreeName: "repo-feature-auth-flow",
      branchName: "feature-auth-flow",
      baseBranch: "main",
      baseRef: "origin/main",
      baseSha: "abc123"
    });
  });

  it("rejects worktree creation when the branch already exists", async () => {
    const repoRoot = path.join(tempRoot, "repo");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} fetch origin main --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-parse --verify origin/main`:
          return { exitCode: 0, stdout: "abc123", stderr: "" };
        case `-C ${repoRoot} show-ref --verify --quiet refs/heads/existing-branch`:
          return { exitCode: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    await expect(
      createGitWorktree({
        cwd: repoRoot,
        name: "Existing Branch"
      })
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      message: 'Local branch "existing-branch" already exists.',
      statusCode: 409
    });
  });

  it("removes a linked worktree, updates main, and deletes the branch", async () => {
    const repoRoot = path.join(tempRoot, "repo");
    const worktreePath = path.join(tempRoot, "repo-feature-auth-flow");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${path.join(worktreePath, "nested")} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: worktreePath, stderr: "" };
        case `-C ${worktreePath} rev-parse --path-format=absolute --git-common-dir`:
          return { exitCode: 0, stdout: path.join(repoRoot, ".git"), stderr: "" };
        case `-C ${worktreePath} symbolic-ref --short -q HEAD`:
          return { exitCode: 0, stdout: "feature-auth-flow", stderr: "" };
        case `-C ${repoRoot} symbolic-ref --short -q HEAD`:
          return { exitCode: 0, stdout: "main", stderr: "" };
        case `-C ${repoRoot} status --porcelain`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} fetch origin main --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} pull --ff-only origin main`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} worktree remove ${worktreePath}`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} show-ref --verify --quiet refs/heads/feature-auth-flow`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} branch --delete feature-auth-flow`:
          return { exitCode: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await cleanupGitWorktree({
      cwd: path.join(worktreePath, "nested"),
      updateBaseBranch: true,
      deleteBranch: true
    });

    expect(result).toEqual({
      repoRoot,
      worktreePath,
      worktreeName: "repo-feature-auth-flow",
      branchName: "feature-auth-flow",
      baseBranch: "main",
      updatedBaseBranch: true,
      deletedBranch: true
    });
  });

  it("rejects cleanup when called from the primary checkout", async () => {
    const repoRoot = path.join(tempRoot, "repo");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} rev-parse --path-format=absolute --git-common-dir`:
          return { exitCode: 0, stdout: path.join(repoRoot, ".git"), stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const cleanupPromise = cleanupGitWorktree({ cwd: repoRoot });

    await expect(cleanupPromise).rejects.toBeInstanceOf(GitWorktreeError);
    await expect(cleanupPromise).rejects.toMatchObject({
      message: "cleanup-worktree only removes linked worktrees, not the primary checkout.",
      statusCode: 400
    });
  });
});
