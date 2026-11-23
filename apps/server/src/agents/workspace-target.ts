import { remotePlacement, workspaceLocator } from "./remote/protocol.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  normalizePath,
  probeGitContext,
  resolveRepoRoot,
} from "../shared/git/git-context.js";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import { detectDefaultBranch } from "../shared/git/default-branch.js";
import { AgentError } from "./errors.js";

const WORKSPACE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Where an agent is working, for everything that looks at its files: the
 * diff, repo tools, brain scope, persona reviews. An agent that moved after
 * launch (a worktree it made, another repo) reports that directory as its
 * workspace; until then it is the managed worktree or the launch cwd.
 *
 * Deliberately separate from `cwd` (the engine spawns and resumes there) and
 * `worktreePath` (the worktree Dispatch created and archive may delete).
 * For remote sessions, `cwd` is the machine binding and `workspacePath`
 * is runner-confirmed display metadata. Checkout operations go to the runner.
 */
export type WorkspaceTargetAgent = {
  cwd: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  workspacePath?: string | null;
  workspaceBaseBranch?: string | null;
  gitContext?: {
    worktreePath: string;
    isWorktree: boolean;
  } | null;
};

/** Persist a native directory or a runner locator without treating the latter as a path. */
export function resolveLaunchLocation(directory: string): string {
  const placement = remotePlacement(directory);
  if (placement) return workspaceLocator(placement);
  if (directory.startsWith("runner://"))
    throw new AgentError("Invalid runner workspace locator.", 400);
  return path.resolve(directory);
}

export function agentWorkspaceDir(agent: WorkspaceTargetAgent): string | null {
  if (agent.cwd && remotePlacement(agent.cwd)) return null;
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
  if (agent.cwd && remotePlacement(agent.cwd)) return null;
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

/**
 * Main's folder check in this process: a directory, moved to its checkout
 * root inside Git, and no move when that is the launch checkout. The local
 * runner's in-process fallback (a session its child holds no binding for).
 */
export async function selectWorkspaceDirectory(
  home: string | null,
  requested: string
): Promise<{ path: string; moved: boolean; repoRoot: string | null }> {
  let dir: string;
  try {
    if (!(await stat(requested)).isDirectory()) {
      throw new AgentError(`${requested} is not a directory.`, 400);
    }
    dir = normalizePath(await realpath(requested));
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(`${requested} does not exist.`, 400);
  }

  const probe = await probeGitContext(dir, {
    timeoutMs: WORKSPACE_PROBE_TIMEOUT_MS,
  });
  if (probe.status === "error") {
    throw new AgentError(`Could not read git state in ${dir}.`, 400);
  }
  const git = probe.value;
  const workspace = git?.worktreePath ?? dir;
  const homeDir = home ? await realpathOrSelf(home) : null;
  return {
    path: workspace,
    moved: workspace !== homeDir,
    repoRoot: git?.repoRoot ?? null,
  };
}

/** `settleWorkspace` with this process's probes (main's local resolution). */
export function resolveWorkspace(
  agent: WorkspaceTargetAgent,
  input: { path: string | null; baseBranch?: string | null },
  run: CommandRunner = runCommand
): Promise<{ path: string | null; baseBranch: string | null }> {
  const home = agent.worktreePath ?? agent.cwd;
  return settleWorkspace(agent, input, {
    select: async (requested) =>
      requested
        ? selectWorkspaceDirectory(home, requested)
        : { path: home ?? "", moved: false, repoRoot: null },
    launchRepoRoot: async () =>
      home
        ? resolveRepoRoot(await realpathOrSelf(home), {
            timeoutMs: WORKSPACE_PROBE_TIMEOUT_MS,
          })
        : null,
    defaultBranch: (dir) => detectDefaultBranch(dir, run),
  });
}

export function isSafeBranchName(name: string): boolean {
  return !name.startsWith("-") && !/\s/.test(name) && !name.includes("..");
}

async function realpathOrSelf(dir: string): Promise<string> {
  try {
    return normalizePath(await realpath(dir));
  } catch {
    return normalizePath(dir);
  }
}
