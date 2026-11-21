import { remotePlacement, type RunnerRepository } from "./remote/protocol.js";
import { localDefaultBranch } from "../shared/git/default-branch.js";
import {
  agentDiffPath,
  type WorkspaceTargetAgent,
} from "./workspace-target.js";

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

/**
 * The branch an agent's work is compared against, computed by the service
 * and passed explicitly to the local and runner executors alike. A moved
 * workspace uses the base recorded when it moved. Otherwise the launch base
 * applies, then the repository's default. Null means the executor resolves
 * it (recorded base, PR base, upstream, main).
 */
export async function agentComparisonBase(
  agent: ComparisonBaseAgent,
  use: ComparisonUse,
  launch?: LaunchCheckout
): Promise<string | null> {
  if (agent.workspacePath) return agent.workspaceBaseBranch ?? null;
  const isRunner = Boolean(agent.cwd && remotePlacement(agent.cwd));
  // Existing-branch launches compare against the opened branch, including PR
  // heads. Older runner rows may only have that branch in the checkout plan.
  const existingBranch =
    launch?.kind === "branch" || launch?.kind === "pr" ? launch.branch : null;
  const storedBase = !isRunner || existingBranch ? agent.baseBranch : null;
  const launchBase =
    launch?.kind === "new" ? launch.base : (storedBase ?? existingBranch);
  if (!isRunner && use === "review") {
    return (
      agent.baseBranch ??
      (agent.worktreePath && agent.worktreeBranch ? "main" : null)
    );
  }
  if (launchBase) return launchBase;

  const managed =
    use === "review"
      ? Boolean(agent.worktreePath && agent.worktreeBranch)
      : Boolean(agent.worktreePath || agent.gitContext?.isWorktree);
  // New runner launches have a known default in launch.base when available.
  // For older or unresolved launches the runner has the checkout's recorded base.
  const cwd = managed ? agentDiffPath(agent) : null;
  return cwd ? localDefaultBranch(cwd) : null;
}
