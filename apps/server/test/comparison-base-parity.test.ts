/*
 * The comparison base a local agent's Changes and review read, pinned on real
 * repositories against the in-process rule it replaced: the repository's
 * default branch, else the checkout's current branch, else "main". The
 * service reads it through the runner (`git.defaultBranch`), in process and
 * through the runner child alike.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Runner } from "@dispatch/runner-protocol/contract";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
  type ComparisonUse,
} from "../src/agents/effective-base.js";
import { agentDiffPath } from "../src/agents/workspace-target.js";
import { localCheckoutWorkload } from "../src/runners/local.js";
import { localDefaultBranch } from "../src/shared/git/default-branch.js";

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

async function repo(name: string, branch: string) {
  const dir = join(root, name);
  await mkdir(dir);
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const fixtures: Record<string, string> = {};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "comparison-base-")));
  // A clone that recorded origin/HEAD (develop), with a Dispatch worktree.
  const upstream = await repo("upstream", "develop");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", upstream, clone]);
  git(clone, "worktree", "add", "-q", "-b", "agt/topic", join(root, "wt"));
  fixtures.worktree = join(root, "wt");
  // No remote; main exists locally.
  fixtures.localMain = await repo("local-main", "main");
  // No remote and no main/master: the current branch.
  fixtures.trunk = await repo("trunk", "trunk");
  // No remote, no main/master, detached: "main".
  fixtures.detached = await repo("detached", "trunk");
  git(fixtures.detached, "checkout", "-q", "--detach");
  // Outside Git, and a folder that is gone.
  fixtures.plain = join(root, "plain");
  await mkdir(fixtures.plain);
  fixtures.gone = join(root, "gone");
}, 60_000);

afterAll(() => rm(root, { recursive: true, force: true }));

const worktreeAgent = (path: string): ComparisonBaseAgent => ({
  cwd: path,
  worktreePath: path,
  worktreeBranch: "agt/topic",
  baseBranch: null,
  workspacePath: null,
  workspaceBaseBranch: null,
});

/** The rule before the reroute, verbatim. */
async function before(agent: ComparisonBaseAgent, use: ComparisonUse) {
  if (agent.workspacePath) return agent.workspaceBaseBranch ?? null;
  if (agent.cwd?.startsWith("runner://")) return null;
  if (use === "review")
    return (
      agent.baseBranch ??
      (agent.worktreePath && agent.worktreeBranch ? "main" : null)
    );
  if (agent.baseBranch) return agent.baseBranch;
  const managed = Boolean(agent.worktreePath || agent.gitContext?.isWorktree);
  const cwd = managed ? agentDiffPath(agent) : null;
  return cwd ? localDefaultBranch(cwd) : null;
}

const USES: ComparisonUse[] = ["changes", "review"];

describe("a local agent's comparison base", () => {
  it.each([
    ["worktree in a clone with origin/HEAD", "worktree", "develop"],
    ["no remote, main exists", "localMain", "main"],
    ["no remote default branch: the current branch", "trunk", "trunk"],
    ["detached head, no default branch", "detached", "main"],
    ["outside Git", "plain", "main"],
    ["a folder that is gone", "gone", "main"],
  ])("%s", async (_name, key, changes) => {
    const agent = worktreeAgent(fixtures[key]!);
    for (const use of USES) {
      const expected = await before(agent, use);
      expect(await agentComparisonBase(agent, use), use).toBe(expected);
    }
    expect(await agentComparisonBase(agent, "changes")).toBe(changes);
  });

  it("without a worktree compares against nothing unless one is recorded", async () => {
    const plainCheckout: ComparisonBaseAgent = {
      ...worktreeAgent(fixtures.trunk!),
      worktreePath: null,
      worktreeBranch: null,
    };
    for (const use of USES) {
      expect(await agentComparisonBase(plainCheckout, use)).toBe(
        await before(plainCheckout, use)
      );
      expect(await agentComparisonBase(plainCheckout, use)).toBeNull();
    }
    const probed = {
      ...plainCheckout,
      gitContext: { worktreePath: fixtures.worktree!, isWorktree: true },
    };
    expect(await agentComparisonBase(probed, "changes")).toBe(
      await before(probed, "changes")
    );
  });

  it("for a runner agent is left to its runner", async () => {
    const runnerAgent: ComparisonBaseAgent = {
      ...worktreeAgent(fixtures.worktree!),
      cwd: "runner://runner-a/@session",
      worktreePath: null,
    };
    for (const use of USES)
      expect(await agentComparisonBase(runnerAgent, use)).toBeNull();
  });

  it("is read through the runner child when it answers, else in process", async () => {
    const agent = worktreeAgent(fixtures.trunk!);
    const inProcess = vi.spyOn(localCheckoutWorkload, "run");
    try {
      const call = vi.fn(async () => ({
        branch: null,
        currentBranch: "from-child",
      }));
      const child = { call } as unknown as Runner;
      expect(
        await agentComparisonBase(agent, "changes", undefined, {
          child: () => child,
        })
      ).toBe("from-child");
      expect(call).toHaveBeenCalledWith(
        "git.defaultBranch",
        { target: { path: fixtures.trunk } },
        expect.anything()
      );
      expect(inProcess).not.toHaveBeenCalled();
      expect(await agentComparisonBase(agent, "changes")).toBe("trunk");
      expect(inProcess).toHaveBeenCalledWith(
        "git.defaultBranch",
        expect.objectContaining({ directory: fixtures.trunk }),
        expect.anything()
      );
    } finally {
      inProcess.mockRestore();
    }
  });
});
