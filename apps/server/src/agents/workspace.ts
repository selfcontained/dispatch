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
