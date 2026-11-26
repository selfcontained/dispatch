import { controllerPlacement, enrolledRunnerId } from "../runners/placement.js";
import type { Placement } from "@dispatch/runner-protocol/contract";
import path from "node:path";

import { AgentError } from "./errors.js";

/**
 * Where an agent is working, for everything that looks at its files: the
 * diff, repo tools, brain scope, persona reviews. An agent that moved after
 * launch (a worktree it made, another repo) reports that directory as its
 * workspace; until then it is the managed worktree or the launch cwd.
 *
 * Deliberately separate from `cwd` (the engine spawns and resumes there) and
 * `worktreePath` (the worktree Dispatch created and archive may delete).
 * For enrolled sessions, `cwd` is the prepared path and `workspacePath`
 * is runner-confirmed display metadata. Checkout operations go to the runner.
 */
export type WorkspaceTargetAgent = {
  cwd: string | null;
  placement?: Placement;
  worktreePath: string | null;
  baseBranch: string | null;
  workspacePath?: string | null;
  workspaceBaseBranch?: string | null;
  gitContext?: {
    worktreePath: string;
    isWorktree: boolean;
  } | null;
};

/** Resolve a directory on the controller. */
export function resolveLaunchLocation(directory: string): string {
  return path.resolve(directory);
}

export function agentWorkspaceDir(agent: WorkspaceTargetAgent): string | null {
  if (enrolledRunnerId(agent.placement ?? controllerPlacement)) return null;
  return agent.workspacePath ?? agent.worktreePath ?? agent.cwd ?? null;
}

/** Path used to make tool locations relative to the session's checkout. */
export function agentStreamDirectory(
  agent: Pick<
    WorkspaceTargetAgent,
    "worktreePath" | "workspacePath" | "gitContext"
  > & { cwd: string }
): string {
  // A host path is where the engine runs; a runner address is not a path,
  // so the checkout the runner reported stands in for it.
  return (
    agent.workspacePath ??
    (path.isAbsolute(agent.cwd)
      ? agent.cwd
      : (agent.worktreePath ?? agent.gitContext?.worktreePath ?? agent.cwd))
  );
}

/** Local path used by Changes, including a worktree discovered on older rows. */
export function agentDiffPath(agent: WorkspaceTargetAgent): string | null {
  if (enrolledRunnerId(agent.placement ?? controllerPlacement)) return null;
  return (
    agent.workspacePath ??
    agent.worktreePath ??
    (agent.gitContext?.isWorktree ? agent.gitContext.worktreePath : null) ??
    agent.cwd
  );
}

/** What a workspace move needs from the machine the agent runs on. */
export type WorkspaceProbes = {
  /**
   * Validate and record the folder (null: back to the launch checkout):
   * the checkout root it sits in (or the folder itself outside Git),
   * whether that is a move away from the launch checkout, and its
   * repository root (null outside Git; undefined from a runner build that
   * does not report it). Throws main's refusals.
   */
  select(path: string | null): Promise<{
    path: string;
    moved: boolean;
    repoRoot: string | null | undefined;
  }>;
  /** The launch checkout's repository root; null when unknown. */
  launchRepoRoot(): Promise<string | null>;
  /** The repository's default branch at `dir`; null when unknown. */
  defaultBranch(dir: string): Promise<string | null>;
};

/**
 * Validate a requested workspace and settle what gets stored: the checkout
 * root it sits in (or the directory itself outside git) and the branch its
 * diff runs against. Resolves to nulls when the request is empty or lands
 * back on the agent's own worktree/cwd without an explicit comparison base.
 * The one base policy for every runner; the probes reach the machine.
 */
export async function settleWorkspace(
  agent: Pick<WorkspaceTargetAgent, "baseBranch">,
  input: { path: string | null; baseBranch?: string | null },
  probes: WorkspaceProbes
): Promise<{ path: string | null; baseBranch: string | null }> {
  const requested = input.path?.trim() ?? "";
  if (requested && !path.isAbsolute(requested)) {
    throw new AgentError("Workspace path must be absolute.", 400);
  }
  const requestedBase = input.baseBranch?.trim() || null;
  if (requested && requestedBase && !isSafeBranchName(requestedBase)) {
    throw new AgentError(`Invalid base branch "${requestedBase}".`, 400);
  }
  const selected = await probes.select(requested || null);
  if (!requested) return { path: null, baseBranch: null };
  // An explicit diff base is a workspace override even at the launch path.
  // Never rewrite baseBranch: it also records how the session was launched.
  if (!selected.moved && !requestedBase) {
    return { path: null, baseBranch: null };
  }
  const workspace = selected.path;
  // A runner that does not report Git facts: the requested base, as before T16.
  if (selected.repoRoot === undefined)
    return { path: workspace, baseBranch: requestedBase };
  if (!selected.repoRoot) return { path: workspace, baseBranch: null };

  if (requestedBase) return { path: workspace, baseBranch: requestedBase };
  // Same repo as the launch checkout: its base still applies.
  if (agent.baseBranch) {
    const homeRepo = await probes.launchRepoRoot().catch(() => null);
    if (homeRepo === selected.repoRoot) {
      return { path: workspace, baseBranch: agent.baseBranch };
    }
  }
  return {
    path: workspace,
    baseBranch: await probes.defaultBranch(workspace).catch(() => null),
  };
}

export function isSafeBranchName(name: string): boolean {
  return !name.startsWith("-") && !/\s/.test(name) && !name.includes("..");
}
