import type { RunnerRepository } from "@dispatch/runner-protocol";
import {
  pathFromWire,
  type Placement,
} from "@dispatch/runner-protocol/contract";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import { controllerPlacement, enrolledRunnerId } from "../runners/placement.js";
import {
  recordedDiffDirectory,
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
  /** The runner the agent's checkout is on (this machine when absent). */
  placement?: Placement;
};

/** The launch checkout a runner session was created from, if any. */
export type LaunchCheckout = RunnerRepository["checkout"] | null | undefined;

/**
 * The branch an agent's work is compared against, computed by the service
 * and passed explicitly to the local and runner executors alike. A moved
 * workspace uses the base recorded when it moved. Otherwise the launch base
 * applies, then the repository's default. Null means the executor resolves
 * it (recorded base, PR base, upstream, repository default).
 */
export async function agentComparisonBase(
  agent: ComparisonBaseAgent,
  use: ComparisonUse,
  launch?: LaunchCheckout,
  /** The runners the service reads through; the local child when started. */
  runners: CheckoutCommandRunners = {}
): Promise<string | null> {
  if (agent.workspacePath) return agent.workspaceBaseBranch ?? null;
  const isRunner =
    enrolledRunnerId(agent.placement ?? controllerPlacement) !== undefined;
  // Existing-branch launches compare against the opened branch, including PR
  // heads. Older runner rows may only have that branch in the checkout plan.
  const existingBranch =
    launch?.kind === "branch" || launch?.kind === "pr" ? launch.branch : null;
  const storedBase = !isRunner || existingBranch ? agent.baseBranch : null;
  const launchBase =
    launch?.kind === "new" ? launch.base : (storedBase ?? existingBranch);
  if (launchBase) return launchBase;

  const managed =
    use === "review"
      ? Boolean(agent.worktreePath && agent.worktreeBranch)
      : Boolean(agent.worktreePath || agent.gitContext?.isWorktree);
  // New runner launches have a known default in launch.base when available.
  // For older or unresolved launches the runner has the checkout's recorded base.
  const cwd = managed && !isRunner ? recordedDiffDirectory(agent) : null;
  if (!cwd) return null;
  // Main's chain: the repository's default, the checkout's current branch,
  // with no invented branch when neither is known. Probes never fail the read.
  const { branch, currentBranch } = await runnerDirectory(runners)
    .for(agent.placement ?? controllerPlacement)
    .call("git.defaultBranch", { target: { path: pathFromWire(cwd) } })
    .catch(() => ({ branch: null, currentBranch: null }));
  return branch ?? currentBranch ?? null;
}
