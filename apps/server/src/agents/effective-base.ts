import { remotePlacement, type RunnerRepository } from "./remote/protocol.js";
import type { WorkspaceTargetAgent } from "./workspace-target.js";

/**
 * What the base is compared for. Changes (diff, file diff, stats) and owner
 * review differ on one detail inherited from local behaviour: Changes treats
 * any probed worktree as managed, review only one Dispatch created on a
 * branch. Both read the same rule below.
 */
export type ComparisonUse = "changes" | "review";

export type ComparisonBaseAgent = WorkspaceTargetAgent & {
  worktreeBranch?: string | null;
};

/** The launch checkout a runner session was created from, if any. */
export type LaunchCheckout = RunnerRepository["checkout"] | null | undefined;

type PlacementRule = {
  /** The base recorded at launch, before any workspace move. */
  launchBase(agent: ComparisonBaseAgent, launch: LaunchCheckout): string | null;
  /** The base when nothing was recorded. Null leaves it to the executor. */
  defaultBase(agent: ComparisonBaseAgent, use: ComparisonUse): string | null;
};

const DEFAULT_WORKTREE_BASE_BRANCH = "main";

/**
 * SWITCH POINT for owner decisions D1 (default base when none was picked) and
 * D2 (base for an agent opened on an existing branch or PR). Today's
 * behaviour differs per placement and is kept here, and only here, until
 * those decisions land:
 *
 * - local: the stored launch base (`agents.base_branch`, which is the opened
 *   branch for an existing-branch launch). Managed worktrees default to `main`.
 * - runner: only a new branch's fork point counts. An existing branch or PR
 *   and a new branch without a base return null, so the runner falls back to
 *   its recorded base (the repository default), then PR base, then upstream.
 */
const PLACEMENT_RULES: Record<"local" | "runner", PlacementRule> = {
  local: {
    launchBase: (agent) => agent.baseBranch ?? null,
    defaultBase: (agent, use) => {
      const managed =
        use === "review"
          ? Boolean(agent.worktreePath && agent.worktreeBranch)
          : Boolean(agent.worktreePath || agent.gitContext?.isWorktree);
      return managed ? DEFAULT_WORKTREE_BASE_BRANCH : null;
    },
  },
  runner: {
    launchBase: (_agent, launch) =>
      launch?.kind === "new" ? (launch.base ?? null) : null,
    defaultBase: () => null,
  },
};

/**
 * The branch an agent's work is compared against, computed by the service
 * and passed explicitly to the local and runner executors alike. A moved
 * workspace uses the base recorded when it moved. Otherwise the launch base
 * applies, then the placement's default. Null means the executor resolves
 * it (recorded base, PR base, upstream, main).
 */
export function agentComparisonBase(
  agent: ComparisonBaseAgent,
  use: ComparisonUse,
  launch?: LaunchCheckout
): string | null {
  if (agent.workspacePath) return agent.workspaceBaseBranch ?? null;
  const rule =
    PLACEMENT_RULES[
      agent.cwd && remotePlacement(agent.cwd) ? "runner" : "local"
    ];
  return rule.launchBase(agent, launch) ?? rule.defaultBase(agent, use);
}
