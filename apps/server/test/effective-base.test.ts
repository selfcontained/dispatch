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
const REMOTE = { cwd: "runner://runner-a/@session", worktreePath: null };
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

  // Unknown runner defaults still resolve on the runner. D2 is unchanged.
  it.each<[Shape, string | null, string | null]>([
    [
      {
        name: "new branch, no base picked (D1)",
        agent: {},
        launch: { kind: "new", branch: "topic" },
      },
      "main",
      null,
    ],
    [
      {
        name: "existing branch (D2)",
        agent: { baseBranch: "feature" },
        launch: { kind: "branch", branch: "feature" },
      },
      "feature",
      null,
    ],
  ])("keeps today's placement rule: %o", async (shape, local, runner) => {
    for (const use of USES) {
      await expect(
        agentComparisonBase(agentFor(LOCAL, shape), use)
      ).resolves.toBe(local);
      await expect(
        agentComparisonBase(agentFor(REMOTE, shape), use, shape.launch)
      ).resolves.toBe(runner);
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
    const requestSession = vi.fn(async () => ({
      value: JSON.stringify({
        data: { files: 1, additions: 2, deletions: 0, uncommittedFiles: 0 },
      }),
    }));
    return {
      requestSession,
      service: { requestSession } as unknown as RemoteRunnerService,
    };
  }

  it("sends the service's base for Changes and stats, view base first", async () => {
    const { requestSession, service } = remote();
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
    const bases = requestSession.mock.calls.map(
      (call) =>
        (call as unknown as [unknown, { query: { baseBranch: string } }])[1]
          .query.baseBranch
    );
    expect(bases).toEqual(["develop", "picked", "develop"]);
  });
});
