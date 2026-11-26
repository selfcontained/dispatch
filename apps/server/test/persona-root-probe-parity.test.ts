import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  resolveWorktreeRoot,
  resolveRepoRoot,
} from "../../../packages/runner/src/workload/shared/git/git-context.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { pathFromWire } from "@dispatch/runner-protocol/contract";

it("pins the independent worktree probe when common-directory probing fails", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "persona-root-probe-"))
  );
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  execFileSync(realGit, ["init", "--quiet", repo]);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *--git-common-dir*) echo 'injected common directory failure' >&2; exit 1;; esac\nexec "$T40_REAL_GIT" "$@"\n`,
    { mode: 0o700 }
  );
  const before = process.env.PATH;
  const beforeGit = process.env.T40_REAL_GIT;
  process.env.PATH = bin + ":" + before;
  process.env.T40_REAL_GIT = realGit;
  try {
    expect(await resolveWorktreeRoot(repo)).toBe(repo);
    expect(await resolveRepoRoot(repo).catch(() => null)).toBeNull();
    expect(
      await runnerDirectory({})
        .for(controllerPlacement)
        .call("git.roots", { target: { path: pathFromWire(repo) } })
    ).toEqual({ repositoryRoot: null, checkoutRoot: null });
    expect(
      await checkoutWorkload.run(
        "git.roots",
        { directory: repo, request: { checkoutOnly: true } },
        {}
      )
    ).toEqual({ repositoryRoot: null, checkoutRoot: repo });
    const executable = process.env.BUN_BINARY ?? "bun";
    const child = execFile(
      executable,
      [
        "--no-env-file",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "runner-worker",
        "git.roots",
        repo,
      ],
      { timeout: 5000 }
    );
    const output = new Promise<string>((resolve, reject) => {
      let data = "";
      let errors = "";
      child.stdout!.on("data", (chunk) => (data += chunk));
      child.stderr!.on("data", (chunk) => (errors += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(data) : reject(new Error(errors))
      );
    });
    child.stdin!.end(
      JSON.stringify({ target: { path: repo }, checkoutOnly: true })
    );
    expect(JSON.parse(await output)).toEqual({
      data: { repositoryRoot: null, checkoutRoot: repo },
    });
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
    if (beforeGit === undefined) delete process.env.T40_REAL_GIT;
    else process.env.T40_REAL_GIT = beforeGit;
    await rm(root, { recursive: true, force: true });
  }
});

it("pins main's independent root results for repository, worktree, plain and missing paths", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "persona-root-table-"))
  );
  const repo = join(root, "repo");
  const plain = join(root, "plain");
  await mkdir(repo);
  await mkdir(plain);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "--quiet");
    await writeFile(join(repo, "seed"), "seed");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "seed"
    );
    const worktree = join(root, "worktree");
    git("worktree", "add", "--quiet", "-b", "root-pin", worktree);
    for (const [cwd, repositoryRoot, checkoutRoot] of [
      [repo, repo, repo],
      [worktree, repo, worktree],
      [plain, null, null],
      [join(root, "missing"), null, null],
    ] as const) {
      expect(await resolveRepoRoot(cwd).catch(() => null)).toBe(repositoryRoot);
      expect(await resolveWorktreeRoot(cwd).catch(() => null)).toBe(
        checkoutRoot
      );
      expect(
        await runnerDirectory({})
          .for(controllerPlacement)
          .call("git.roots", { target: { path: pathFromWire(cwd) } })
      ).toEqual({ repositoryRoot, checkoutRoot });
      const defaults = await checkoutWorkload.run(
        "git.roots",
        { directory: cwd, request: {} },
        {}
      );
      expect(JSON.stringify(defaults)).toBe(
        JSON.stringify({ checkoutRoot, repositoryRoot })
      );
      expect(
        await checkoutWorkload.run(
          "git.roots",
          { directory: cwd, request: { checkoutOnly: true } },
          {}
        )
      ).toEqual({ repositoryRoot: null, checkoutRoot });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
