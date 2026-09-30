import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentDiffTarget,
  agentWorkspaceDir,
  detectDefaultBranch,
  resolveWorkspace,
} from "../src/agents/workspace-target.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

async function initRepo(dir: string, branch: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

describe("agentDiffTarget", () => {
  it("diffs a moved workspace against its recorded base", () => {
    expect(
      agentDiffTarget({
        cwd: "/launch",
        worktreePath: "/launch",
        baseBranch: "main",
        workspacePath: "/other",
        workspaceBaseBranch: "develop",
      })
    ).toEqual({ path: "/other", baseRef: "develop" });
  });

  it("keeps the managed worktree and its base when not moved", () => {
    expect(
      agentDiffTarget({
        cwd: "/wt",
        worktreePath: "/wt",
        baseBranch: null,
        workspacePath: null,
      })
    ).toEqual({ path: "/wt", baseRef: "main" });
  });

  it("leaves a plain checkout's base to the resolver", () => {
    expect(
      agentDiffTarget({ cwd: "/repo", worktreePath: null, baseBranch: null })
    ).toEqual({ path: "/repo", baseRef: null });
  });

  it("uses a probed linked worktree for older rows", () => {
    expect(
      agentDiffTarget({
        cwd: "/repo/sub",
        worktreePath: null,
        baseBranch: null,
        gitContext: { worktreePath: "/wt", isWorktree: true },
      })
    ).toEqual({ path: "/wt", baseRef: "main" });
  });

  it("names the workspace, then the worktree, then cwd", () => {
    expect(
      agentWorkspaceDir({
        cwd: "/c",
        worktreePath: "/w",
        baseBranch: null,
        workspacePath: "/s",
      })
    ).toBe("/s");
    expect(
      agentWorkspaceDir({ cwd: "/c", worktreePath: "/w", baseBranch: null })
    ).toBe("/w");
  });
});

describe("resolveWorkspace", () => {
  let root: string;
  let launchRepo: string;
  let launchWorktree: string;
  let ownWorktree: string;
  let otherRepo: string;
  let plainDir: string;

  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "dispatch-workspace-test-"))
    );
    launchRepo = path.join(root, "launch");
    await initRepo(launchRepo, "main");
    launchWorktree = path.join(root, "launch-wt");
    git(launchRepo, "worktree", "add", "-q", "-b", "agent/wt", launchWorktree);
    ownWorktree = path.join(root, "own-wt");
    git(launchRepo, "worktree", "add", "-q", "-b", "agent/own", ownWorktree);
    otherRepo = path.join(root, "other");
    await initRepo(otherRepo, "master");
    git(otherRepo, "checkout", "-q", "-b", "fix/thing");
    plainDir = path.join(root, "plain");
    await mkdir(plainDir);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const launchedAgent = () => ({
    cwd: launchWorktree,
    worktreePath: launchWorktree,
    baseBranch: "main",
  });

  it("adopts a worktree the agent made in the same repo, keeping the launch base", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), { path: ownWorktree })
    ).resolves.toEqual({ path: ownWorktree, baseBranch: "main" });
  });

  it("stores the checkout root when given a subdirectory", async () => {
    const sub = path.join(ownWorktree, "nested");
    await mkdir(sub, { recursive: true });
    await expect(
      resolveWorkspace(launchedAgent(), { path: sub })
    ).resolves.toEqual({ path: ownWorktree, baseBranch: "main" });
  });

  it("detects another repo's default branch", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), { path: otherRepo })
    ).resolves.toEqual({ path: otherRepo, baseBranch: "master" });
  });

  it("honours an explicit base branch", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), {
        path: otherRepo,
        baseBranch: "release",
      })
    ).resolves.toEqual({ path: otherRepo, baseBranch: "release" });
  });

  it("clears the override when pointed back at the launch worktree", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), { path: launchWorktree })
    ).resolves.toEqual({ path: null, baseBranch: null });
    await expect(
      resolveWorkspace(launchedAgent(), { path: null })
    ).resolves.toEqual({ path: null, baseBranch: null });
  });

  it("accepts a directory outside git with no base", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), { path: plainDir })
    ).resolves.toEqual({ path: plainDir, baseBranch: null });
  });

  it("rejects relative, missing and file paths, and flag-like bases", async () => {
    await expect(
      resolveWorkspace(launchedAgent(), { path: "relative/dir" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveWorkspace(launchedAgent(), { path: path.join(root, "nope") })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveWorkspace(launchedAgent(), {
        path: path.join(launchRepo, ".git", "HEAD"),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveWorkspace(launchedAgent(), {
        path: otherRepo,
        baseBranch: "--all",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("prefers origin/HEAD for the default branch", async () => {
    const clone = path.join(root, "clone");
    execFileSync("git", ["clone", "-q", otherRepo, clone]);
    await expect(detectDefaultBranch(clone)).resolves.toBe("fix/thing");
    await expect(detectDefaultBranch(plainDir)).resolves.toBeNull();
  });
});
