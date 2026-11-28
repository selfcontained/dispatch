import path from "node:path";
import type { GitContext } from "@dispatch/runner-protocol/git-context";

/** Compose a gitContext from a checkout's probed roots and branch. */
export function gitContextFrom(input: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  repoIconPath: string | null;
}): GitContext {
  return {
    repoRoot: input.repoRoot,
    branch: input.branch,
    worktreePath: input.worktreePath,
    worktreeName: path.basename(input.worktreePath),
    isWorktree: input.worktreePath !== input.repoRoot,
    repoIconPath: input.repoIconPath,
  };
}
