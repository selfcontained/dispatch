import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchingProjects } from "./helpers/project-matching.js";

describe("starting directory project matching", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-matching-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const project = (repoRoot: string, id = "p") => ({ id, name: id, repoRoot });

  it("matches folders, nested directories and symlinks without prefix collisions", async () => {
    mkdirSync(join(root, "folder/nested"), { recursive: true });
    mkdirSync(join(root, "folder-other"));
    symlinkSync(join(root, "folder"), join(root, "alias"));
    const p = project(join(root, "folder"));
    expect(await matchingProjects(join(root, "alias/nested"), [p])).toEqual([
      p,
    ]);
    expect(await matchingProjects(join(root, "folder-other"), [p])).toEqual([]);
  });

  it("returns all ambiguous matches for caller choice, without creating a project", async () => {
    mkdirSync(join(root, "nested"));
    const projects = [project(root), project(join(root, "nested"), "q")];
    expect(await matchingProjects(join(root, "nested"), projects)).toEqual(
      projects
    );
    expect(await matchingProjects(root, [])).toEqual([]);
    expect(
      await matchingProjects(root, [project(join(root, "missing"))])
    ).toEqual([]);
  });

  it("resolves a linked worktree and its subdirectory to the primary project", async () => {
    const repo = join(root, "repo");
    const git = (...args: string[]) => execFileSync("git", args);
    git("init", "-q", repo);
    git(
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init"
    );
    const worktree = join(root, "worktree");
    git("-C", repo, "worktree", "add", "-qb", "test", worktree);
    mkdirSync(join(worktree, "nested"));
    const p = project(repo);
    expect(await matchingProjects(join(worktree, "nested"), [p])).toEqual([p]);
  });

  it("matches extra roots by path without matching another clone's origin", async () => {
    const primary = join(root, "primary");
    const extra = join(root, "extra");
    const unrelated = join(root, "unrelated");
    const repository = "https://example.test/team/repo.git";
    for (const checkout of [primary, extra, unrelated]) {
      execFileSync("git", ["init", "-q", checkout]);
      execFileSync("git", [
        "-C",
        checkout,
        "remote",
        "add",
        "origin",
        repository,
      ]);
    }
    const p = { ...project(primary), extraRoots: [extra], repository };
    expect(await matchingProjects(extra, [p])).toEqual([p]);
    expect(await matchingProjects(unrelated, [p])).toEqual([]);
  });
});
