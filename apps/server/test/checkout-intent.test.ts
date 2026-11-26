import type { RepositoryCheckout } from "@dispatch/runner-protocol";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRepository } from "../src/agents/remote/repository.js";
import { getPullRequestHead } from "../../../packages/runner/src/workload/shared/github/pr.js";
import {
  resolveCheckoutIntent,
  runnerDefaultBranch,
  toLocalWorktreeRequest,
  toRunnerCheckout,
  type CheckoutIntent,
} from "../src/agents/checkout-intent.js";
import { AgentManager } from "../src/agents/manager.js";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { agentComparisonBase } from "../src/agents/effective-base.js";
import { readAgentView } from "../src/agents/checkout-runner.js";
import { inspectCheckout } from "./helpers/checkout-inspection.js";
import { listLocalRemoteBranches } from "../../../packages/runner/src/workload/agents/local-workspace-probes.js";
import { createGitWorktree } from "../../../packages/runner/src/workload/shared/git/worktree.js";
import { runnerWorktree } from "../src/agents/workspace-launch.js";

/**
 * What the local runner checks out for a request it is sent (its core's
 * rule, run for real in local-workspace-preparation.test.ts): the base
 * defaults to `main`, and without a new branch the base is checked out.
 */
function checkedOut(request: Parameters<typeof runnerWorktree>[0]) {
  const sent = runnerWorktree(request);
  const base = sent.base ?? "main";
  return { branch: sent.create ? sent.branch : base, base };
}

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
      expect(checkedOut(request)).toEqual({
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
      });
      const local = await resolveCheckoutIntent(
        {},
        {
          ...context,
          defaultBranch: async () => {
            const { branch, currentBranch } = await runnerDirectory({})
              .for(controllerPlacement)
              .call("git.defaultBranch", {
                target: { path: pathFromWire(cwd) },
              });
            return branch ?? currentBranch ?? "main";
          },
        }
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
            {
              ...agent,
              cwd: "/runner/session",
              placement: placementForRunner("runner"),
              worktreePath: null,
            },
            use,
            launch
          )
        ).toBe(branch);
        expect(
          await agentComparisonBase({ ...agent, baseBranch: null }, use)
        ).toBe(use === "review" ? "main" : branch);
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

it("defaults a native Create Agent request to main even when the Git default is trunk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-native-base-"));
  try {
    git(root, "init", "-b", "trunk", "repo");
    const cwd = path.join(root, "repo");
    git(cwd, "commit", "--allow-empty", "-m", "initial");
    const prepared = new Error("Checkout intent prepared");
    const prepareCreateInputs = vi.fn(
      async (
        input: CheckoutIntent,
        _cwd: string,
        options: { defaultBranch: () => Promise<string> }
      ) => {
        const intent = await resolveCheckoutIntent(input, {
          ...context,
          ...options,
        });
        expect(intent.normalizedBaseBranch).toBe("main");
        throw prepared;
      }
    );
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      config: { agentRuntime: "acp" },
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      localRunner: {
        resolveLaunchDirectory: vi.fn().mockResolvedValue({
          cwd,
          canonicalPath: cwd,
          git: { status: "ok", value: {} },
        }),
      },
      prepareCreateInputs,
    }) as AgentManager;
    await expect(
      AgentManager.prototype.createAgent.call(manager, { cwd })
    ).rejects.toBe(prepared);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses main for a native worktree request with no recorded base", () => {
  expect(checkedOut({ branch: "feature", createNewBranch: true })).toEqual({
    branch: "feature",
    base: "main",
  });
  expect(checkedOut({ branch: "", createNewBranch: false })).toEqual({
    branch: "main",
    base: "main",
  });
});

describe("pull request intent", () => {
  const repository = async () => "https://github.com/owner/repo";
  it.each([true, false])(
    "routes the enrolled launch lookup with a selected folder: %s",
    async (hasFolder) => {
      const origin = "https://github.com/owner/repo";
      const target = { owner: "owner", repo: "repo", number: 12 };
      const head = { url: origin, branch: "topic" };
      const call = vi.fn(async () => head);
      const prepared = new Error("lookup complete");
      const manager = Object.assign(Object.create(AgentManager.prototype), {
        remote: { call },
        async prepareCreateInputs(
          _input: unknown,
          _cwd: string,
          options: {
            pullRequestHead: (pr: typeof target) => Promise<typeof head>;
          }
        ) {
          expect(await options.pullRequestHead(target)).toEqual(head);
          throw prepared;
        },
      });
      await expect(
        manager.prepareCreate(
          {},
          {},
          {
            placement: placementForRunner("test"),
            location: "test",
            directory: null,
            ...(hasFolder && {
              launcherDirectory: {
                cwd: "/link",
                canonicalPath: "/work/checkout",
                origin,
                git: { status: "ok", value: {} },
              },
            }),
          },
          { repository: { url: origin } }
        )
      ).rejects.toBe(prepared);
      expect(call).toHaveBeenCalledExactlyOnceWith(
        "test",
        "github.pr.head",
        {
          ...target,
          ...(hasFolder && { cwd: "/work/checkout" }),
        },
        undefined,
        undefined
      );
    }
  );

  it.each([
    ["https://github.com/../repo", "#12"],
    ["https://github.com/owner/.", "#12"],
    ["https://github.com/owner/repo", "https://github.com/owner/../pull/12"],
  ])(
    "rejects dot segments before looking up a PR (%s, %s)",
    async (url, pullRequest) => {
      const pullRequestHead = vi.fn();
      await expect(
        resolveCheckoutIntent(
          { pullRequest },
          {
            ...context,
            repository: async () => url,
            pullRequestHead,
          }
        )
      ).rejects.toThrow(/GitHub (repository|pull request URL or number)/);
      expect(pullRequestHead).not.toHaveBeenCalled();
    }
  );
  const heads = {
    sameRepo: { url: "https://github.com/owner/repo.git", branch: "topic" },
    fork: { url: "https://github.com/someone/repo.git", branch: "fix" },
  };
  // What the web used to submit after calling /pull-request-head itself.
  const browserCheckout = (head: { url: string; branch: string }) =>
    parseRepository({
      url: head.url,
      checkout: { kind: "branch", branch: head.branch },
    });

  it.each(["sameRepo", "fork"] as const)(
    "opens a %s PR on a runner exactly as the browser did",
    async (kind) => {
      const lookup = vi.fn(async () => heads[kind]);
      const { checkout, normalizedBaseBranch } = await resolveCheckoutIntent(
        {
          createNewBranch: false,
          pullRequest: "https://github.com/Owner/Repo/pull/12",
        },
        { ...context, repository, pullRequestHead: lookup }
      );
      expect(lookup).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        number: 12,
      });
      expect(checkout?.source).toBe("pullRequest");
      if (checkout?.source !== "pullRequest") throw new Error("PR expected");
      expect(
        parseRepository({
          url: checkout.repository,
          checkout: toRunnerCheckout(checkout),
        })
      ).toEqual(browserCheckout(heads[kind]));
      expect(normalizedBaseBranch).toBe(heads[kind].branch);
    }
  );

  it("preserves the PR head lookup's command and response failures", async () => {
    const target = { owner: "owner", repo: "repo", number: 12, cwd: "/repo" };
    const failure = new Error("gh: fixture failure");
    await expect(
      getPullRequestHead(target, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    for (const stdout of [
      "{}",
      '{"url":"https://github.com/o/r.git","branch":""}',
    ]) {
      await expect(
        getPullRequestHead(target, async () => ({
          stdout,
          stderr: "",
          exitCode: 0,
        }))
      ).rejects.toThrow("GitHub pull request source branch is unavailable.");
    }
    let parseFailure: unknown;
    try {
      JSON.parse("!");
    } catch (error) {
      parseFailure = error;
    }
    await expect(
      getPullRequestHead(target, async () => ({
        stdout: "!",
        stderr: "",
        exitCode: 0,
      }))
    ).rejects.toEqual(parseFailure);
  });

  it("opens a same-repository PR locally as its existing branch", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify(heads.sameRepo),
      stderr: "",
      exitCode: 0,
    }));
    const { checkout } = await resolveCheckoutIntent(
      { createNewBranch: false, pullRequest: "#12" },
      {
        ...context,
        repository,
        pullRequestHead: (target) =>
          getPullRequestHead({ cwd: "/repo", ...target }, run as never),
        forkPullRequests: false,
      }
    );
    // Same query the runner's GitHub executor runs.
    expect(run).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "repos/owner/repo/pulls/12",
        "--jq",
        "{url:.head.repo.clone_url,branch:.head.ref}",
      ],
      { cwd: "/repo", timeoutMs: 15_000 }
    );
    const request = toLocalWorktreeRequest(checkout!, context.name);
    expect(request).toMatchObject({
      createNewBranch: false,
      baseBranch: "topic",
    });
    expect(checkedOut(request)).toEqual({
      branch: "topic",
      base: "topic",
    });
  });

  it.each([
    [
      "a PR from another repository",
      { pullRequest: "https://github.com/other/repo/pull/12" },
      { pullRequestHead: async () => heads.sameRepo },
      "Choose a pull request from the selected repository.",
    ],
    [
      "a PR that cannot be found",
      { pullRequest: "https://github.com/owner/repo/pull/404" },
      {
        pullRequestHead: async () => {
          throw new Error("HTTP 404");
        },
      },
      "Couldn’t find the source branch of pull request #404",
    ],
    [
      "a fork PR on a local checkout",
      { pullRequest: "12" },
      { pullRequestHead: async () => heads.fork, forkPullRequests: false },
      "This pull request comes from a fork.",
    ],
    [
      "a launch without a GitHub repository",
      { pullRequest: "12" },
      { repository: async () => undefined },
      "Opening a pull request needs a GitHub repository.",
    ],
    [
      "something that is not a PR",
      { pullRequest: "https://example.com/owner/repo/pull/1" },
      {},
      "Enter a GitHub pull request URL or number.",
    ],
  ])("rejects %s", async (_, input, options, message) => {
    await expect(
      resolveCheckoutIntent(
        { createNewBranch: false, ...input },
        { ...context, repository, ...options }
      )
    ).rejects.toThrow(message);
  });
});
