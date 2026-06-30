import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(),
}));

const { createGitWorktree, cleanupGitWorktree, GitWorktreeError } =
  await import("../src/shared/git/worktree.js");
const { runCommand } = await import("../src/shared/lib/run-command.js");

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
        case `-C ${repoRoot} remote get-url origin`:
          return {
            exitCode: 0,
            stdout: "git@github.com:test/repo.git",
            stderr: "",
          };
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
      name: "Feature Auth Flow",
      createNewBranch: true,
    });

    expect(result).toEqual({
      repoRoot,
      worktreePath: expectedWorktreePath,
      worktreeName: "repo-feature-auth-flow",
      branchName: "feature-auth-flow",
      baseBranch: "main",
      baseRef: "origin/main",
      baseSha: "abc123",
    });
  });

  it("derives a hashed worktree-path slug when createNewBranch is false (review #1161)", async () => {
    // `feature/x` and `feature-x` slug-collapse to `feature-x` with the
    // legacy mapping. The hash discriminator added for createNewBranch=false
    // gives each its own on-disk path.
    const repoRoot = path.join(tempRoot, "repo");
    const adds: string[] = [];

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");
      if (key.startsWith(`-C ${repoRoot} worktree add `)) {
        adds.push(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} remote get-url origin`:
          return {
            exitCode: 0,
            stdout: "git@github.com:test/repo.git",
            stderr: "",
          };
        case `-C ${repoRoot} fetch origin feature/x --quiet`:
        case `-C ${repoRoot} fetch origin feature-x --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-parse --verify origin/feature/x`:
        case `-C ${repoRoot} rev-parse --verify origin/feature-x`:
          return { exitCode: 0, stdout: "deadbeef", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const a = await createGitWorktree({
      cwd: repoRoot,
      name: "x",
      baseBranch: "feature/x",
      createNewBranch: false,
    });
    const b = await createGitWorktree({
      cwd: repoRoot,
      name: "y",
      baseBranch: "feature-x",
      createNewBranch: false,
    });

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.worktreePath).toMatch(/-feature-x-[0-9a-f]{6}$/);
    expect(b.worktreePath).toMatch(/-feature-x-[0-9a-f]{6}$/);
  });

  it("checks out an existing branch when createNewBranch is false", async () => {
    const repoRoot = path.join(tempRoot, "repo");
    let recordedWorktreePath: string | null = null;
    const calls: string[] = [];

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");
      calls.push(key);
      const addPrefix = `-C ${repoRoot} worktree add `;
      if (key.startsWith(addPrefix)) {
        const rest = key.slice(addPrefix.length);
        const [pathArg, branchArg] = rest.split(" ");
        recordedWorktreePath = pathArg;
        expect(branchArg).toBe("feature/x");
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} remote get-url origin`:
          return {
            exitCode: 0,
            stdout: "git@github.com:test/repo.git",
            stderr: "",
          };
        case `-C ${repoRoot} fetch origin feature/x --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-parse --verify origin/feature/x`:
          return { exitCode: 0, stdout: "deadbeef", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await createGitWorktree({
      cwd: repoRoot,
      name: "Review Branch X",
      baseBranch: "feature/x",
      createNewBranch: false,
    });

    // Path slug derives from the base branch with a hash discriminator (see
    // worktreePathSlug). Lock the prefix and the 6-char hex suffix shape.
    expect(result.worktreePath).toMatch(
      new RegExp(`^${tempRoot}/repo-feature-x-[0-9a-f]{6}$`)
    );
    expect(recordedWorktreePath).toBe(result.worktreePath);
    // Must not pre-check for a clashing branch — the user's branch is expected
    // to exist.
    expect(
      calls.some((c) => c.includes("show-ref --verify --quiet refs/heads/"))
    ).toBe(false);
    // Must not set upstream tracking — we're on the user's branch as-is.
    expect(calls.some((c) => c.includes("--set-upstream-to"))).toBe(false);
    expect(result.branchName).toBe("feature/x");
    expect(result.baseBranch).toBe("feature/x");
  });

  it("rejects worktree creation when the branch already exists", async () => {
    const repoRoot = path.join(tempRoot, "repo");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} remote get-url origin`:
          return {
            exitCode: 0,
            stdout: "git@github.com:test/repo.git",
            stderr: "",
          };
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
        name: "Existing Branch",
        createNewBranch: true,
      })
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      message: 'Local branch "existing-branch" already exists.',
      statusCode: 409,
    });
  });

  it("falls back to local branch when no origin remote exists", async () => {
    const repoRoot = path.join(tempRoot, "repo");
    const expectedWorktreePath = path.join(tempRoot, "repo-feature-local");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} remote get-url origin`:
          return {
            exitCode: 2,
            stdout: "",
            stderr: "fatal: No such remote 'origin'",
          };
        case `-C ${repoRoot} rev-parse --verify main`:
          return { exitCode: 0, stdout: "localsha", stderr: "" };
        case `-C ${repoRoot} show-ref --verify --quiet refs/heads/feature-local`:
        case `-C ${repoRoot} show-ref --verify --quiet refs/remotes/origin/feature-local`:
          return { exitCode: 1, stdout: "", stderr: "" };
        case `-C ${repoRoot} worktree add -b feature-local ${expectedWorktreePath} main`:
        case `-C ${expectedWorktreePath} branch --set-upstream-to main feature-local`:
          return { exitCode: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await createGitWorktree({
      cwd: repoRoot,
      name: "Feature Local",
      createNewBranch: true,
    });

    expect(result.baseRef).toBe("main");
    expect(result.baseSha).toBe("localsha");
  });

  it("propagates unexpected remote-probe failures instead of falling back", async () => {
    const repoRoot = path.join(tempRoot, "repo");

    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const key = args.join(" ");

      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} remote get-url origin`:
          throw new Error("spawn git ENOENT");
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    await expect(
      createGitWorktree({
        cwd: repoRoot,
        name: "Should Fail",
        createNewBranch: true,
      })
    ).rejects.toThrow("spawn git ENOENT");
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
          return {
            exitCode: 0,
            stdout: path.join(repoRoot, ".git"),
            stderr: "",
          };
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
      deleteBranch: true,
    });

    expect(result).toEqual({
      repoRoot,
      worktreePath,
      worktreeName: "repo-feature-auth-flow",
      branchName: "feature-auth-flow",
      baseBranch: "main",
      updatedBaseBranch: true,
      deletedBranch: true,
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
          return {
            exitCode: 0,
            stdout: path.join(repoRoot, ".git"),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const cleanupPromise = cleanupGitWorktree({ cwd: repoRoot });

    await expect(cleanupPromise).rejects.toBeInstanceOf(GitWorktreeError);
    await expect(cleanupPromise).rejects.toMatchObject({
      message:
        "cleanup-worktree only removes linked worktrees, not the primary checkout.",
      statusCode: 400,
    });
  });
});
