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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  projectRepositoryUrl,
  repositoryUrl,
} from "../src/agents/remote/repository.js";
import { resolveProjectRoot } from "../src/projects/resolve-root.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import {
  identityKey,
  projectIdentities,
  projectKey,
  repositoryKey,
} from "../src/runners/repository-identity.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";

const runner = placementForRunner("rnr_identity");

describe("repository identity (D5, D8)", () => {
  it("a controller root is its own key; another runner's root is not a key", () => {
    expect(identityKey(controllerPlacement, "/srv/repo")).toBe("/srv/repo");
    expect(identityKey(controllerPlacement, null)).toBeNull();
    expect(identityKey(runner, "/home/runner/repo")).toBeNull();
  });

  it("a controller session reads its root and never its project", async () => {
    const project = vi.fn();
    await expect(
      repositoryKey({
        placement: controllerPlacement,
        repositoryRoot: async () => "/srv/repo",
        project,
      })
    ).resolves.toBe("/srv/repo");
    // A local folder with no repository has no key, even in a project (main).
    await expect(
      repositoryKey({
        placement: controllerPlacement,
        repositoryRoot: async () => null,
        project,
      })
    ).resolves.toBeNull();
    expect(project).not.toHaveBeenCalled();
  });

  it("a runner session takes its project's key and never reads its own root", async () => {
    const repositoryRoot = vi.fn();
    const key = (
      project: { repoRoot: string | null; repository: string | null } | null
    ) =>
      repositoryKey({
        placement: runner,
        repositoryRoot,
        project: async () => project,
      });
    await expect(
      key({ repoRoot: "/srv/repo", repository: "https://github.com/o/r" })
    ).resolves.toBe("/srv/repo");
    await expect(
      key({ repoRoot: null, repository: "https://github.com/o/r" })
    ).resolves.toBe("https://github.com/o/r");
    // No project: no key until the owner decides (N18).
    await expect(key(null)).resolves.toBeNull();
    expect(repositoryRoot).not.toHaveBeenCalled();
  });

  it("project keys follow D8's order", () => {
    expect(projectKey(null)).toBeNull();
    expect(projectKey({ repoRoot: null, repository: null })).toBeNull();
    expect(projectKey({ repoRoot: "/a", repository: "https://x/y" })).toBe(
      "/a"
    );
  });

  it("reads each project once", async () => {
    const read = vi.fn(async (id: string) => ({
      repoRoot: id,
      repository: null,
    }));
    const project = projectIdentities(read);
    await project("p1");
    await project("p1");
    await project(null);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("a project's primary root is the key its local agents already use", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-identity-key-")));
    mkdirSync(join(root, "repo/a"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", join(root, "repo")]);
    execFileSync(
      "git",
      ["-C", join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "i"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }
    );
    execFileSync("git", [
      "-C",
      join(root, "repo"),
      "worktree",
      "add",
      "-q",
      "-b",
      "wt",
      "../wt",
    ]);
    symlinkSync(join(root, "repo"), join(root, "link"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Projects store `resolveProjectRoot` of the folder they were made from; a
  // local agent anywhere in that checkout is keyed by `resolveRepoRoot`.
  it.each(["repo", "repo/a", "wt", "link", "link/a"])(
    "made from %s",
    async (folder) => {
      const stored = await resolveProjectRoot(join(root, folder));
      expect(stored).toBe(join(root, "repo"));
      expect(await resolveRepoRoot(join(root, folder))).toBe(stored);
    }
  );
});

describe("option A readiness: a session's repository key equals its project's", () => {
  // A project stores `projectRepositoryUrl(input)`; a runner launch stores
  // `repositoryUrl(url)` in `agents.runner_repository`. Option A would key a
  // project-less session by `projectRepositoryUrl` of that stored URL.
  it.each([
    "https://github.com/Owner/Repo",
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo/",
    "https://github.com/Owner/Repo.git/",
    "https://GitHub.com/Owner/Repo",
    "https://github.com:443/Owner/Repo",
    "https://git.example.com/group/sub/repo.git",
  ])("%s", (spelling) => {
    const project = projectRepositoryUrl(spelling);
    const session = projectRepositoryUrl(repositoryUrl(spelling));
    expect(session).toBe(project);
  });

  it("a URL with credentials is stored by neither", () => {
    const spelling = "https://user:token@github.com/Owner/Repo.git";
    expect(() => projectRepositoryUrl(spelling)).toThrow();
    expect(() => repositoryUrl(spelling)).toThrow();
  });

  it("an origin read from Git keys the same as the URL typed for the project", () => {
    expect(
      projectRepositoryUrl(repositoryUrl("git@github.com:Owner/Repo.git", true))
    ).toBe(projectRepositoryUrl("https://github.com/Owner/Repo"));
  });
});
