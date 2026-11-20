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
import { agentDiffTarget } from "../src/agents/workspace-target.js";
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
  ])("gives local and runner the same base: %o", (shape, expected) => {
    for (const use of USES) {
      expect(agentComparisonBase(agentFor(LOCAL, shape), use)).toBe(expected);
      expect(
        agentComparisonBase(agentFor(REMOTE, shape), use, shape.launch)
      ).toBe(expected);
    }
  });

  // D1/D2 are owner decisions; today's per-placement rule stays until then.
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
  ])("keeps today's placement rule: %o", (shape, local, runner) => {
    for (const use of USES) {
      expect(agentComparisonBase(agentFor(LOCAL, shape), use)).toBe(local);
      expect(
        agentComparisonBase(agentFor(REMOTE, shape), use, shape.launch)
      ).toBe(runner);
    }
  });

  it("matches main's local Changes and review defaults", () => {
    const probed = {
      cwd: "/repo",
      worktreePath: null,
      baseBranch: null,
      gitContext: { worktreePath: "/repo", isWorktree: true },
    };
    expect(agentComparisonBase(probed, "changes")).toBe("main");
    expect(agentComparisonBase(probed, "review")).toBeNull();
    const unnamed = { cwd: "/wt", worktreePath: "/wt", baseBranch: null };
    expect(agentComparisonBase(unnamed, "changes")).toBe("main");
    expect(agentComparisonBase(unnamed, "review")).toBeNull();
    expect(agentDiffTarget(probed)).toEqual({ path: "/repo", baseRef: "main" });
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
