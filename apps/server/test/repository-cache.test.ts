/*
 * The workspace port's repository cache with real Git against a local bare
 * remote: a clone with no branch checked out, tags, reuse with a fetch, the
 * remote's default branch, and pull request heads.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceWorkload } from "../src/agents/checkout-worker.js";

const repositoryCache = workspaceWorkload.repository;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0)) run();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message
  );

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-cache-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "trunk");
  commit(work, "first");
  git(work, "tag", "v1");
  const bare = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return {
    root,
    work,
    bare,
    cache: join(root, "cache", "k"),
    clone: join(root, "cache", "k", "origin"),
  };
}

describe("repository cache", () => {
  it("clones with tags and no checked-out branch, then reuses with a fetch", async () => {
    const { bare, work, cache, clone } = setup();
    expect(await repositoryCache.cache(bare, cache, clone)).toEqual({
      defaultBranch: "trunk",
    });
    expect(git(clone, "tag")).toBe("v1");
    expect(git(clone, "branch", "--list")).toMatch(/no branch|detached/);
    expect(readdirSync(cache)).toEqual(["origin"]);

    commit(work, "later");
    git(work, "tag", "v2");
    git(work, "push", "-q", bare, "trunk", "v2");
    await repositoryCache.cache(bare, cache, clone);
    expect(git(clone, "rev-parse", "origin/trunk")).toBe(
      git(work, "rev-parse", "trunk")
    );
    expect(git(clone, "tag").split("\n")).toEqual(["v1", "v2"]);

    // The default branch can be a worktree through the directory steps.
    const spec = {
      directory: clone,
      name: "trunk",
      branch: "trunk",
      base: "trunk",
      create: false,
    };
    const plan = await workspaceWorkload.plan(spec);
    const made = await workspaceWorkload.create(spec, plan.path);
    expect(made.branch).toBe("trunk");
    expect(git(made.path, "describe", "--tags")).toBe("v2");
  });

  it("refuses an unreachable repository and leaves no partial clone", async () => {
    const { root, cache, clone } = setup();
    await expect(
      repositoryCache.cache(join(root, "missing.git"), cache, clone)
    ).rejects.toMatchObject({
      code: "failed",
      message: "Could not clone the repository.",
    });
    expect(readdirSync(cache)).toEqual([]);
    expect(existsSync(clone)).toBe(false);
  });

  it("fetches a pull request head into its branch, refusing diverged work", async () => {
    const { bare, work, cache, clone } = setup();
    git(work, "checkout", "-q", "-b", "contrib");
    commit(work, "contribution");
    const head = git(work, "rev-parse", "HEAD");
    const publish = () =>
      git(work, "push", "-q", "--force", bare, "HEAD:refs/pull/3/head");
    publish();
    await repositoryCache.cache(bare, cache, clone);
    await repositoryCache.pullRequest(clone, 3, "contrib");
    expect(git(clone, "rev-parse", "contrib")).toBe(head);
    // Already there: nothing to do.
    await repositoryCache.pullRequest(clone, 3, "contrib");

    git(
      clone,
      "update-ref",
      "refs/heads/contrib",
      git(clone, "rev-parse", "v1")
    );
    commit(work, "more");
    publish();
    // Behind the head: fast-forwarded.
    await repositoryCache.pullRequest(clone, 3, "contrib");
    expect(git(clone, "rev-parse", "contrib")).toBe(
      git(work, "rev-parse", "HEAD")
    );

    git(work, "checkout", "-q", "--orphan", "other");
    commit(work, "unrelated");
    publish();
    await expect(
      repositoryCache.pullRequest(clone, 3, "contrib")
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
