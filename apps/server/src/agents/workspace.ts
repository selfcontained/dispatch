import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { createGitWorktree } from "../shared/git/worktree.js";
import { setupAgentWorkspace } from "./workspace-prep.js";
import type { SetupPhase } from "./types.js";

export type PrepareWorkspaceInput = {
  agentName: string;
  originalCwd: string;
  useWorktree: boolean;
  createNewBranch: boolean;
  worktreeBranchName: string | undefined;
  baseBranch: string | undefined;
  worktreePathOverride: string | undefined;
  /** Phase transitions, for the sidebar's setup progress. */
  onPhase: (phase: SetupPhase) => Promise<void>;
  /**
   * Walk the phases on a timer instead of doing them, this many ms apiece;
   * see `simulateWorkspace`. Only an inert runtime passes it.
   */
  simulateMs?: number;
};

export type PreparedWorkspace = {
  effectiveCwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
};

/**
 * Make an agent's workspace: the worktree (when asked for), the copied
 * local config files, the installed dependencies. This is the one place the
 * server touches an agent's filesystem before launch; when a remote host
 * exists, this call becomes a host RPC with the same shape.
 *
 * Throws on a failed worktree creation (a `GitWorktreeError` carries its
 * status code); a failed dependency install is logged and tolerated, as it
 * was in the pane script.
 */
export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
  logger: FastifyBaseLogger
): Promise<PreparedWorkspace> {
  if (input.simulateMs !== undefined) {
    return simulateWorkspace(input, input.simulateMs);
  }
  if (!input.useWorktree || !input.worktreeBranchName) {
    await input.onPhase("session");
    return {
      effectiveCwd: input.originalCwd,
      worktreePath: null,
      worktreeBranch: null,
    };
  }
  await input.onPhase("worktree");
  const result = await createGitWorktree({
    cwd: input.originalCwd,
    name: input.agentName,
    branchName: input.createNewBranch ? input.worktreeBranchName : undefined,
    baseBranch: input.baseBranch,
    worktreePath: input.worktreePathOverride,
    createNewBranch: input.createNewBranch,
  });
  logger.info(
    { worktreePath: result.worktreePath, worktreeBranch: result.branchName },
    "Created worktree."
  );
  await input.onPhase("deps");
  await setupAgentWorkspace(input.originalCwd, result.worktreePath, logger);
  await input.onPhase("session");
  return {
    effectiveCwd: result.worktreePath,
    worktreePath: result.worktreePath,
    worktreeBranch: result.branchName,
  };
}

/**
 * The same phases, in the same order, with nothing done in them: for
 * watching a launch come up in the stream again and again on a dev stack
 * without a git worktree and an install behind every try.
 *
 * The agent lands in an empty directory under the temp dir, laid out as a
 * worktree's path is, so the stream has a real-length path to show. It is
 * not recorded as a worktree: archiving the agent must never go looking for
 * a branch or a checkout to remove.
 */
export async function simulateWorkspace(
  input: PrepareWorkspaceInput,
  ms: number
): Promise<PreparedWorkspace> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, ms));
  if (!input.useWorktree || !input.worktreeBranchName) {
    await input.onPhase("session");
    await pause();
    return {
      effectiveCwd: input.originalCwd,
      worktreePath: null,
      worktreeBranch: null,
    };
  }
  await input.onPhase("worktree");
  await pause();
  const dir = path.join(
    os.tmpdir(),
    "dispatch-simulated-workspaces",
    path.basename(input.originalCwd),
    ".dispatch",
    "worktrees",
    input.worktreeBranchName.replace(/[^\w.-]+/g, "-")
  );
  await mkdir(dir, { recursive: true });
  await input.onPhase("deps");
  await pause();
  await input.onPhase("session");
  await pause();
  return { effectiveCwd: dir, worktreePath: null, worktreeBranch: null };
}
