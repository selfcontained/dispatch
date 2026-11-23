import path from "node:path";
import type { AgentGitContext } from "./types.js";

/** Compose a gitContext from a checkout's probed roots and branch. */
export function gitContextFrom(input: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  repoIconPath: string | null;
}): AgentGitContext {
  return {
    repoRoot: input.repoRoot,
    branch: input.branch,
    worktreePath: input.worktreePath,
    worktreeName: path.basename(input.worktreePath),
    isWorktree: input.worktreePath !== input.repoRoot,
    repoIconPath: input.repoIconPath,
  };
}
