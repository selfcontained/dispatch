import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommand } from "../src/shared/lib/run-command.js";
import {
  cleanupGitWorktree,
  createGitWorktree,
  normalizeBaseBranch,
} from "../src/shared/git/worktree.js";

// Real local repositories: no network, production checkout, or host git config.
describe("origin-qualified worktree bases", () => {
  let tempRoot: string;
  let repo: string;
  let localSha: string;
  let remoteSha: string;
  const git = async (...args: string[]) =>
    (await runCommand("git", ["-C", repo, ...args])).stdout.trim();

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-origin-base-"));
    repo = path.join(tempRoot, "repo");
    const origin = path.join(tempRoot, "origin.git");
    await runCommand("git", ["init", "--bare", origin]);
    await runCommand("git", ["init", "-b", "main", repo]);
    await git("config", "user.name", "Dispatch Test");
    await git("config", "user.email", "dispatch@example.test");
    await git("config", "commit.gpgsign", "false");
    await git("commit", "--allow-empty", "-m", "Local base");
    localSha = await git("rev-parse", "HEAD");
    await git("branch", "feature/x");
    await git("checkout", "-b", "parking");
    await git("commit", "--allow-empty", "-m", "Remote base");
    remoteSha = await git("rev-parse", "HEAD");
    await git("remote", "add", "origin", origin);
    await git("push", "origin", "HEAD:main", "HEAD:feature/x");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const cases = ["main", "feature/x"].flatMap((branch) =>
    [false, true].flatMap((qualified) =>
      [false, true].flatMap((createNewBranch) =>
        [false, true].map((updateBase) => ({
          branch,
          qualified,
          createNewBranch,
          updateBase,
        }))
      )
    )
  );

  it.each(cases)(
    "$branch qualified=$qualified createNewBranch=$createNewBranch updateBase=$updateBase",
    async ({ branch, qualified, createNewBranch, updateBase }) => {
      const baseBranch = qualified ? `  origin/${branch}  ` : branch;
      const explicitBranch = "origin/explicit-output";
      const worktree = await createGitWorktree({
        cwd: repo,
        name: "Origin base",
        baseBranch,
        branchName: explicitBranch,
        createNewBranch,
        updateBase,
      });
      expect(worktree.baseBranch).toBe(branch);
      expect(worktree.baseRef).toBe(updateBase ? `origin/${branch}` : branch);
      expect(worktree.baseSha.trim()).toBe(updateBase ? remoteSha : localSha);
      expect(worktree.branchName).toBe(
        createNewBranch ? explicitBranch : branch
      );
      expect(
        await git(
          "-C",
          worktree.worktreePath,
          "symbolic-ref",
          "--short",
          "HEAD"
        )
      ).toBe(createNewBranch ? explicitBranch : branch);
      // Existing-branch mode preserves its local tip even when origin is newer.
      expect(await git("-C", worktree.worktreePath, "rev-parse", "HEAD")).toBe(
        createNewBranch && updateBase ? remoteSha : localSha
      );

      const cleanup = await cleanupGitWorktree({
        cwd: worktree.worktreePath,
        baseBranch,
        deleteBranch: createNewBranch,
        force: true,
      });
      expect(cleanup.baseBranch).toBe(branch);
      expect(cleanup.deletedBranch).toBe(createNewBranch);
      const branches = await git("branch", "--format=%(refname:short)");
      expect(branches.split("\n")).toContain(branch);
      expect(branches.split("\n")).not.toContain(explicitBranch);
    }
  );

  it("normalizes cleanup fetch/pull and primary-branch comparison", async () => {
    await git("checkout", "main");
    const worktree = await createGitWorktree({
      cwd: repo,
      name: "Cleanup",
      baseBranch: "origin/main",
      createNewBranch: true,
    });
    const result = await cleanupGitWorktree({
      cwd: worktree.worktreePath,
      baseBranch: " origin/main ",
      updateBaseBranch: true,
      deleteBranch: true,
    });
    expect(result.baseBranch).toBe("main");
    expect(result.updatedBaseBranch).toBe(true);
    expect(await git("rev-parse", "main")).toBe(remoteSha);
  });

  it.each([false, true])(
    "bases on an unpushed local branch createNewBranch=%s",
    async (createNewBranch) => {
      await git("branch", "agt_parent/agent-1", "main");
      const worktree = await createGitWorktree({
        cwd: repo,
        name: "Unpushed base",
        baseBranch: "agt_parent/agent-1",
        branchName: "agt_child/agent-2",
        createNewBranch,
      });
      expect(worktree.baseRef).toBe("agt_parent/agent-1");
      expect(worktree.baseSha.trim()).toBe(localSha);
      expect(await git("-C", worktree.worktreePath, "rev-parse", "HEAD")).toBe(
        localSha
      );
    }
  );

  it("still fails when the base branch exists neither locally nor on origin", async () => {
    await expect(
      createGitWorktree({
        cwd: repo,
        name: "Missing base",
        baseBranch: "no-such-branch",
        createNewBranch: true,
      })
    ).rejects.toThrow(/couldn't find remote ref/);
  });

  it.each([
    "origin/",
    "origin/origin/main",
    " origin/origin/feature/x ",
    "origin/--all",
    "--all",
    "origin/ main",
    "origin/main;echo",
    "origin/$(id)",
  ])(
    "rejects invalid input %s before worktree mutation",
    async (baseBranch) => {
      await expect(
        createGitWorktree({ cwd: repo, name: "Invalid", baseBranch })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(
        (await git("worktree", "list", "--porcelain")).match(/^worktree /gm)
      ).toHaveLength(1);
    }
  );
});

it.each([
  ["main", "main"],
  ["origin/main", "main"],
  [" feature/x ", "feature/x"],
  [" origin/feature/x ", "feature/x"],
])("normalizes base %s to %s once", (input, expected) => {
  expect(normalizeBaseBranch(input)).toBe(expected);
  expect(normalizeBaseBranch(normalizeBaseBranch(input))).toBe(expected);
});

it.each(["origin/origin/main", " origin/origin/feature/x "])(
  "rejects nested base alias %s directly",
  (input) => {
    expect(() => normalizeBaseBranch(input)).toThrow("nested origin/ prefixes");
  }
);
