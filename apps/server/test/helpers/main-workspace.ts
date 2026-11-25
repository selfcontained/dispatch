import type { WorkspaceTargetAgent } from "../../src/agents/workspace-target.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  normalizePath,
  probeGitContext,
  resolveRepoRoot,
} from "../../src/shared/git/git-context.js";
import {
  runCommand,
  type CommandRunner,
} from "../../src/shared/lib/run-command.js";
import { AgentError } from "../../src/agents/errors.js";

const WORKSPACE_PROBE_TIMEOUT_MS = 5_000;

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
  // An explicit diff base is a workspace override even at the launch path.
  // Never rewrite baseBranch: it also records how the session was launched.
  if (workspace === homeDir && !requestedBase) {
    return { path: null, baseBranch: null };
  }
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
