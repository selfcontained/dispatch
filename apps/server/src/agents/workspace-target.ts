import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  normalizePath,
  probeGitContext,
  resolveRepoRoot,
} from "../shared/git/git-context.js";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
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

const DEFAULT_WORKTREE_BASE_BRANCH = "main";

export function agentWorkspaceDir(agent: WorkspaceTargetAgent): string | null {
  return agent.workspacePath ?? agent.worktreePath ?? agent.cwd ?? null;
}

/**
 * The directory and base branch a diff of the agent's work runs against.
 * A moved workspace diffs against the base recorded when it moved. Otherwise
 * managed worktrees (or older rows whose probed git context says worktree)
 * default to `main`, and plain checkouts leave the base to the resolver.
 */
export function agentDiffTarget(
  agent: WorkspaceTargetAgent
): { path: string; baseRef: string | null } | null {
  if (agent.workspacePath) {
    return {
      path: agent.workspacePath,
      baseRef: agent.workspaceBaseBranch ?? null,
    };
  }
  const gitContextWorktreePath = agent.gitContext?.isWorktree
    ? agent.gitContext.worktreePath
    : null;
  const path = agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd;
  if (!path) return null;
  const baseRef =
    agent.baseBranch ??
    (agent.worktreePath || gitContextWorktreePath
      ? DEFAULT_WORKTREE_BASE_BRANCH
      : null);
  return { path, baseRef };
}

/**
 * Validate a requested workspace and settle what gets stored: the checkout
 * root it sits in (or the directory itself outside git) and the branch its
 * diff runs against. Resolves to nulls when the request is empty or lands
 * back on the agent's own worktree/cwd, which clears the override.
 */
export async function resolveWorkspace(
  agent: WorkspaceTargetAgent,
  input: { path: string | null; baseBranch?: string | null },
  run: CommandRunner = runCommand
): Promise<{ path: string | null; baseBranch: string | null }> {
  const requested = input.path?.trim() ?? "";
  if (!requested) return { path: null, baseBranch: null };
  if (!path.isAbsolute(requested)) {
    throw new AgentError("Workspace path must be absolute.", 400);
  }
  const requestedBase = input.baseBranch?.trim() || null;
  if (requestedBase && !isSafeBranchName(requestedBase)) {
    throw new AgentError(`Invalid base branch "${requestedBase}".`, 400);
  }

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

  const home = agent.worktreePath ?? agent.cwd;
  const homeDir = home ? await realpathOrSelf(home) : null;
  if (workspace === homeDir) return { path: null, baseBranch: null };
  if (!git) return { path: workspace, baseBranch: null };

  if (requestedBase) return { path: workspace, baseBranch: requestedBase };
  // Same repo as the launch checkout: its base still applies.
  if (agent.baseBranch && homeDir) {
    const homeRepo = await resolveRepoRoot(homeDir, {
      timeoutMs: WORKSPACE_PROBE_TIMEOUT_MS,
    }).catch(() => null);
    if (homeRepo === git.repoRoot) {
      return { path: workspace, baseBranch: agent.baseBranch };
    }
  }
  return {
    path: workspace,
    baseBranch: await detectDefaultBranch(workspace, run),
  };
}

/**
 * The repo's default branch: origin/HEAD when the clone recorded it,
 * otherwise the first of main/master that exists. Null when none do.
 */
export async function detectDefaultBranch(
  dir: string,
  run: CommandRunner = runCommand
): Promise<string | null> {
  const opts = {
    allowedExitCodes: [0, 1, 128],
    timeoutMs: WORKSPACE_PROBE_TIMEOUT_MS,
  };
  const originHead = await run(
    "git",
    ["-C", dir, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    opts
  ).catch(() => null);
  const fromOrigin = originHead?.exitCode === 0 ? originHead.stdout.trim() : "";
  if (fromOrigin.startsWith("origin/")) {
    return fromOrigin.slice("origin/".length);
  }
  for (const branch of ["main", "master"]) {
    for (const ref of [`origin/${branch}`, branch]) {
      const found = await run(
        "git",
        ["-C", dir, "rev-parse", "--verify", "--quiet", ref],
        opts
      ).catch(() => null);
      if (found?.exitCode === 0 && found.stdout.trim()) return branch;
    }
  }
  return null;
}

function isSafeBranchName(name: string): boolean {
  return !name.startsWith("-") && !/\s/.test(name) && !name.includes("..");
}

async function realpathOrSelf(dir: string): Promise<string> {
  try {
    return normalizePath(await realpath(dir));
  } catch {
    return normalizePath(dir);
  }
}
