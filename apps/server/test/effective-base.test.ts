import { placementForRunner } from "../src/runners/placement.js";
import { describe, expect, it, vi } from "vitest";
import {
  readAgentStats,
  readAgentView,
} from "../src/agents/checkout-runner.js";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
  type ComparisonUse,
  type LaunchCheckout,
} from "../src/agents/effective-base.js";
import { agentDiffPath } from "../src/agents/workspace-target.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";

const LOCAL = {
  cwd: "/repo/.dispatch/worktrees/a",
  worktreePath: "/repo/.dispatch/worktrees/a",
};
const REMOTE = {
  placement: placementForRunner("runner-a"),
  cwd: "/runner/session",
  worktreePath: null,
};
const USES: ComparisonUse[] = ["changes", "review"];

type Shape = {
  name: string;
  agent: Partial<ComparisonBaseAgent>;
  launch?: LaunchCheckout;
};

function agentFor(placement: typeof LOCAL | typeof REMOTE, shape: Shape) {
  return {
    baseBranch: null,
    worktreeBranch: placement === LOCAL ? "agt/topic" : null,
    workspacePath: null,
    workspaceBaseBranch: null,
    ...placement,
    ...shape.agent,
  } as ComparisonBaseAgent;
}

describe("agentComparisonBase", () => {
  it.each<[Shape, string | null]>([
    [
      {
        name: "new branch with a picked base",
        agent: { baseBranch: "develop" },
        launch: { kind: "new", branch: "topic", base: "develop" },
      },
      "develop",
    ],
    [
      {
        name: "existing branch, ahead of origin with edits",
        agent: { baseBranch: "feature" },
        launch: { kind: "branch", branch: "feature" },
      },
      "feature",
    ],
    [
      {
        name: "existing branch, fully pushed",
        agent: { baseBranch: "feature" },
        launch: { kind: "branch", branch: "feature" },
      },
      "feature",
    ],
    [
      {
        name: "existing branch, local ref only",
        agent: { baseBranch: "feature" },
        launch: { kind: "branch", branch: "feature" },
      },
      "feature",
    ],
    [
      {
        name: "existing branch, plain checkout with a stored base",
        agent: {
          baseBranch: "feature",
          worktreePath: null,
          worktreeBranch: null,
        },
        launch: { kind: "branch", branch: "feature" },
      },
      "feature",
    ],
    [
      {
        name: "PR source resolved to a branch checkout",
        agent: { baseBranch: "pr-head" },
        launch: { kind: "branch", branch: "pr-head" },
      },
      "pr-head",
    ],
    [
      {
        name: "moved workspace with a base",
        agent: { workspacePath: "/elsewhere", workspaceBaseBranch: "release" },
        launch: { kind: "new", branch: "topic", base: "develop" },
      },
      "release",
    ],
    [
      {
        name: "moved workspace without a base",
        agent: { workspacePath: "/elsewhere", baseBranch: "develop" },
        launch: { kind: "new", branch: "topic", base: "develop" },
      },
      null,
    ],
  ])("gives local and runner the same base: %o", async (shape, expected) => {
    for (const use of USES) {
      await expect(
        agentComparisonBase(agentFor(LOCAL, shape), use)
      ).resolves.toBe(expected);
      await expect(
        agentComparisonBase(agentFor(REMOTE, shape), use, shape.launch)
      ).resolves.toBe(expected);
    }
  });

  it.each<LaunchCheckout>([
    { kind: "branch", branch: "feature" },
    { kind: "pr", branch: "feature", number: 42 },
  ])("uses the checkout branch for a legacy runner row: %o", async (launch) => {
    const agent = agentFor(REMOTE, { name: "legacy", agent: {} });
    for (const use of USES) {
      await expect(agentComparisonBase(agent, use, launch)).resolves.toBe(
        "feature"
      );
    }
  });

  it("leaves unresolved defaults to the runner", async () => {
    const shape: Shape = {
      name: "new branch, no base picked (D1)",
      agent: {},
      launch: { kind: "new", branch: "topic" },
    };
    for (const use of USES) {
      await expect(
        agentComparisonBase(agentFor(LOCAL, shape), use)
      ).resolves.toBe("main");
      await expect(
        agentComparisonBase(agentFor(REMOTE, shape), use, shape.launch)
      ).resolves.toBeNull();
      await expect(
        agentComparisonBase(agentFor(REMOTE, shape), use)
      ).resolves.toBeNull();
    }
  });

  it("matches main's local Changes and review defaults", async () => {
    const probed = {
      cwd: "/repo",
      worktreePath: null,
      baseBranch: null,
      gitContext: { worktreePath: "/repo", isWorktree: true },
    };
    await expect(agentComparisonBase(probed, "changes")).resolves.toBe("main");
    await expect(agentComparisonBase(probed, "review")).resolves.toBeNull();
    const unnamed = { cwd: "/wt", worktreePath: "/wt", baseBranch: null };
    await expect(agentComparisonBase(unnamed, "changes")).resolves.toBe("main");
    await expect(agentComparisonBase(unnamed, "review")).resolves.toBeNull();
    expect(agentDiffPath(probed)).toBe("/repo");
  });
});

describe("explicit base to the runner executor", () => {
  function remote() {
    const call = vi.fn(
      async (_runner: string, op: string, _input: { base: string }) =>
        op === "checkout.stats"
          ? { files: 1, additions: 2, deletions: 0, uncommittedFiles: 0 }
          : null
    );
    return { call, service: { call } as unknown as RemoteRunnerService };
  }

  it("sends the service's base for Changes and stats, view base first", async () => {
    const { call, service } = remote();
    const agent = { ...agentFor(REMOTE, { name: "", agent: {} }), id: "agt_r" };
    await readAgentView(
      agent,
      {
        kind: "diff",
        baseBranch: null,
        includeUncommitted: true,
        ignoreWhitespace: false,
      },
      service,
      "develop"
    ).catch(() => null);
    await readAgentView(
      agent,
      {
        kind: "diff",
        baseBranch: "picked",
        includeUncommitted: true,
        ignoreWhitespace: false,
      },
      service,
      "develop"
    ).catch(() => null);
    await readAgentStats("agt_r", agent, service, "develop").catch(() => null);
    const bases = call.mock.calls.map(([, , input]) => input.base);
    expect(bases).toEqual(["develop", "picked", "develop"]);
  });
});
