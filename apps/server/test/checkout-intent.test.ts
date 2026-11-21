import type { RepositoryCheckout } from "@dispatch/runner-protocol";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveCheckoutIntent,
  resolveLocalCheckout,
  runnerDefaultBranch,
  toLocalWorktreeRequest,
  toRunnerCheckout,
  type CheckoutIntent,
} from "../src/agents/checkout-intent.js";
import { localDefaultBranch } from "../src/shared/git/default-branch.js";
import { agentComparisonBase } from "../src/agents/effective-base.js";
import { readAgentView } from "../src/agents/checkout-runner.js";
import { inspectCheckout } from "../src/agents/checkout-inspection.js";
import { listLocalRemoteBranches } from "../src/agents/local-workspace-probes.js";
import { createGitWorktree } from "../src/shared/git/worktree.js";

const context = { id: "agt_example", name: " A new agent! " };

describe("checkout intent", () => {
  it.each<[string, CheckoutIntent, string, string, RepositoryCheckout]>([
    [
      "named new branch with an explicit base",
      { worktreeBranch: " origin/topic ", baseBranch: " origin/release " },
      "origin/topic",
      "release",
      { kind: "new", branch: "origin/topic", base: "release" },
    ],
    [
      "automatic branch with an explicit base",
      { baseBranch: "main" },
      "agt_example/a-new-agent",
      "main",
      { kind: "new", branch: "agt_example/a-new-agent", base: "main" },
    ],
    [
      "blank refs",
      { worktreeBranch: " ", baseBranch: " " },
      "agt_example/a-new-agent",
      "trunk",
      { kind: "new", branch: "agt_example/a-new-agent", base: "trunk" },
    ],
    [
      "existing branch with an unused new-branch name",
      {
        createNewBranch: false,
        worktreeBranch: "ignored",
        baseBranch: "origin/release",
      },
      "release",
      "release",
      { kind: "branch", branch: "release", allowDefault: true },
    ],
    [
      "existing default branch",
      { createNewBranch: false },
      "trunk",
      "trunk",
      { kind: "branch", branch: "trunk", allowDefault: true },
    ],
  ])(
    "preserves both placements for %s",
    async (_, input, branch, base, runner) => {
      const { checkout, normalizedBaseBranch } = await resolveCheckoutIntent(
        input,
        {
          ...context,
          defaultBranch: async () => "trunk",
        }
      );
      expect(normalizedBaseBranch).toBe(base);
      if (!checkout) throw new Error("Expected a worktree intent");
      const request = toLocalWorktreeRequest(checkout, context.name, "nested");
      expect(request.location).toBe("nested");
      await expect(resolveLocalCheckout("/repo", request)).resolves.toEqual({
        branch,
        base,
      });
      expect(toRunnerCheckout(checkout)).toEqual(runner);
    }
  );

  it("leaves unknown runner defaults for the checkout executor", async () => {
    for (const createNewBranch of [true, false]) {
      const { checkout, normalizedBaseBranch } = await resolveCheckoutIntent(
        { createNewBranch },
        { ...context, defaultBranch: async () => undefined }
      );
      expect(normalizedBaseBranch).toBeUndefined();
      expect(toRunnerCheckout(checkout!)).toEqual(
        createNewBranch
          ? { kind: "new", branch: "agt_example/a-new-agent" }
          : { kind: "default" }
      );
    }
    const oldRunner = vi.fn(async () => ({ branches: ["main"] }));
    await expect(
      runnerDefaultBranch("https://github.com/owner/repo.git", oldRunner)
    ).resolves.toBeUndefined();
    expect(oldRunner).toHaveBeenCalledWith("owner", "repo");
  });

  it("preserves the recorded base without a worktree", async () => {
    expect(
      await resolveCheckoutIntent(
        { useWorktree: false, baseBranch: "origin/release" },
        context
      )
    ).toEqual({ normalizedBaseBranch: "release", checkout: null });
    await expect(
      resolveCheckoutIntent(
        { useWorktree: false, worktreeBranch: "bad ref" },
        context
      )
    ).rejects.toThrow("worktreeBranch");
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Tester",
      "-c",
      "user.email=test@example.test",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

it.each([
  { branch: "main", originHead: true },
  { branch: "trunk", originHead: true },
  { branch: "main", originHead: false },
])(
  "uses $branch for both placements (origin/HEAD present: $originHead)",
  async ({ branch, originHead }) => {
    const root = await mkdtemp(path.join(tmpdir(), "dispatch-default-base-"));
    try {
      git(root, "init", "-b", branch, "origin");
      const origin = path.join(root, "origin");
      git(origin, "commit", "--allow-empty", "-m", "initial");
      git(root, "clone", origin, "clone");
      const cwd = path.join(root, "clone");
      if (!originHead)
        git(cwd, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      if (branch !== "main") git(cwd, "branch", "main");

      await expect(listLocalRemoteBranches(cwd)).resolves.toEqual({
        branches: [branch],
        defaultBranch: branch,
      });
      const local = await resolveCheckoutIntent(
        {},
        { ...context, defaultBranch: () => localDefaultBranch(cwd) }
      );
      const remote = await resolveCheckoutIntent(
        {},
        {
          ...context,
          defaultBranch: () =>
            runnerDefaultBranch(
              "https://github.com/owner/repo.git",
              async () => ({ branches: [branch], defaultBranch: branch })
            ),
        }
      );
      expect(local.normalizedBaseBranch).toBe(branch);
      expect(remote).toEqual(local);
      const launch = toRunnerCheckout(remote.checkout!);
      expect(launch).toMatchObject({ kind: "new", base: branch });

      const worktreePath = path.join(root, "worktree");
      await createGitWorktree({
        cwd,
        name: context.name,
        worktreePath,
        branchName: local.checkout!.branch,
        createNewBranch: true,
        baseBranch: local.checkout!.base,
      });
      await writeFile(path.join(worktreePath, "source.txt"), "feature\n");
      git(worktreePath, "add", "source.txt");
      git(worktreePath, "commit", "-m", "feature");

      const agent = {
        id: context.id,
        cwd: worktreePath,
        worktreePath,
        worktreeBranch: local.checkout!.branch,
        baseBranch: local.normalizedBaseBranch!,
      };
      for (const use of ["changes", "review"] as const) {
        expect(await agentComparisonBase(agent, use)).toBe(branch);
        expect(
          await agentComparisonBase(
            { ...agent, cwd: "runner://runner/@session", worktreePath: null },
            use,
            launch
          )
        ).toBe(branch);
        expect(
          await agentComparisonBase({ ...agent, baseBranch: null }, use)
        ).toBe(branch);
      }
      const changes = await readAgentView(agent, {
        kind: "diff",
        baseBranch: null,
        includeUncommitted: true,
        ignoreWhitespace: false,
      });
      const review = await inspectCheckout(
        worktreePath,
        {
          kind: "changes",
          baseBranch: await agentComparisonBase(agent, "review"),
        },
        { recordedBase: false }
      );
      expect(changes).toMatchObject({
        baseRef: git(cwd, "rev-parse", `origin/${branch}`),
      });
      expect(review).toMatchObject({ baseRef: `origin/${branch}` });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
