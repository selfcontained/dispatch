/*
 * A folder's default branch, as origin/main's `detectDefaultBranch` reads it
 * (copied verbatim below): origin/HEAD, else the first of main/master that
 * Git resolves by its short name, so a tag of that name counts.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { afterEach, expect, it } from "vitest";
import {
  runCommand,
  type CommandRunner,
} from "../src/shared/lib/run-command.js";
import { detectDefaultBranch } from "../src/shared/git/default-branch.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";

/** origin/main `apps/server/src/agents/workspace-target.ts`, verbatim. */
async function mainDetectDefaultBranch(
  dir: string,
  run: CommandRunner = runCommand
): Promise<string | null> {
  const opts = {
    allowedExitCodes: [0, 1, 128],
    timeoutMs: 5_000,
  };
  const originHead = await run(
    "git",
    ["-C", dir, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    opts
  ).catch(() => null);
  const fromOrigin = originHead?.exitCode === 0 ? originHead.stdout.trim() : "";
  if (fromOrigin.startsWith("origin/")) {
    return fromOrigin.slice("origin/".length);
  }
  for (const branch of ["main", "master"]) {
    for (const ref of [`origin/${branch}`, branch]) {
      const found = await run(
        "git",
        ["-C", dir, "rev-parse", "--verify", "--quiet", ref],
        opts
      ).catch(() => null);
      if (found?.exitCode === 0 && found.stdout.trim()) return branch;
    }
  }
  return null;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function repo(
  steps: (git: (...args: string[]) => void, dir: string) => void
) {
  const dir = await mkdtemp(join(tmpdir(), "default-branch-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  steps(git, dir);
  return dir;
}

const commit = (git: (...args: string[]) => void) =>
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture"
  );

const cases: Array<
  [string, (git: (...args: string[]) => void, dir: string) => void]
> = [
  [
    "a tag named main, only branch feature",
    (git) => {
      git("init", "-qb", "feature");
      commit(git);
      git("tag", "main");
    },
  ],
  [
    "a tag named master, only branch feature",
    (git) => {
      git("init", "-qb", "feature");
      commit(git);
      git("tag", "master");
    },
  ],
  [
    "a main branch",
    (git) => {
      git("init", "-qb", "main");
      commit(git);
    },
  ],
  [
    "a master branch",
    (git) => {
      git("init", "-qb", "master");
      commit(git);
    },
  ],
  [
    "origin/HEAD recorded",
    (git) => {
      git("init", "-qb", "feature");
      commit(git);
      git("update-ref", "refs/remotes/origin/trunk", "HEAD");
      git(
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk"
      );
    },
  ],
  [
    "only origin/main",
    (git) => {
      git("init", "-qb", "feature");
      commit(git);
      git("update-ref", "refs/remotes/origin/main", "HEAD");
    },
  ],
  [
    "a detached head with no main or master",
    (git) => {
      git("init", "-qb", "feature");
      commit(git);
      git("checkout", "-q", "--detach");
    },
  ],
  ["not a repository", () => {}],
];

it.each(cases)("%s answers as main", async (_, steps) => {
  const dir = await repo(steps);
  const expected = await mainDetectDefaultBranch(dir);
  expect(await detectDefaultBranch(dir)).toBe(expected);
  const runner = runnerDirectory({}).for(controllerPlacement);
  expect(
    (
      await runner.call("git.defaultBranch", {
        target: { path: pathFromWire(dir) },
      })
    ).branch
  ).toBe(expected);
});
