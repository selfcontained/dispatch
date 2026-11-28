import { AgentManager } from "../src/agents/manager.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectCheckout } from "../../../packages/runner/src/workload/agents/checkout-inspection.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it("pins main's live roots for unborn, plain, missing, file, worktree, bare and submodule paths", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "git-roots-parity-"))
  );
  roots.push(root);
  const repo = join(root, "repo");
  const plain = join(root, "plain");
  const file = join(root, "file");
  await mkdir(repo);
  await mkdir(plain);
  await writeFile(file, "file");
  git(repo, "init", "--quiet");
  const check = async (
    cwd: string,
    repositoryRoot: string | null,
    checkoutRoot: string | null
  ) => {
    const agent = {
      id: "root-pin",
      cwd,
      placement: controllerPlacement,
      worktreePath: null,
      workspacePath: null,
    };
    const manager = { checkoutReadRunners: () => ({ local: undefined }) };
    const result = await AgentManager.prototype.inspectCheckout.call(
      manager as never,
      agent as never,
      { kind: "roots" }
    );
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({ kind: "roots", checkoutRoot, repositoryRoot })
    );
    expect(await inspectCheckout(cwd, { kind: "roots" })).toEqual({
      kind: "roots",
      repositoryRoot,
      checkoutRoot,
    });
    expect(
      await runnerDirectory({})
        .for(controllerPlacement)
        .call("git.roots", { target: { path: pathFromWire(cwd) } })
    ).toEqual({ repositoryRoot, checkoutRoot });
  };
  await check(repo, repo, repo);
  await check(plain, null, null);
  await check(join(root, "missing"), null, null);
  await check(file, null, null);
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const worktree = join(root, "worktree");
  git(repo, "worktree", "add", "--quiet", "-b", "work", worktree);
  await check(worktree, repo, worktree);
  const bare = join(root, "bare");
  git(root, "init", "--quiet", "--bare", bare);
  await check(bare, null, null);
  const source = join(root, "source");
  git(root, "init", "--quiet", source);
  git(source, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    source,
    "module"
  );
  const module = join(repo, "module");
  await check(module, module, module);
  const moved = await AgentManager.prototype.inspectCheckout.call(
    { checkoutReadRunners: () => ({ local: undefined }) } as never,
    {
      id: "moved-pin",
      cwd: repo,
      worktreePath: worktree,
      workspacePath: source,
      placement: controllerPlacement,
    } as never,
    { kind: "roots" }
  );
  expect(JSON.stringify(moved)).toBe(
    JSON.stringify({
      kind: "roots",
      checkoutRoot: source,
      repositoryRoot: source,
    })
  );

  git(plain, "init", "--quiet");
  await check(plain, plain, plain);
  await rm(join(plain, ".git"), { recursive: true, force: true });
  await check(plain, null, null);
});
