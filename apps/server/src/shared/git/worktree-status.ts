import { runCommand } from "../lib/run-command.js";

export type WorktreeStatus = {
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};

export type UnmergedChanges = {
  hasUnmergedCommits: boolean;
  changedFiles: string[];
};

export type UncommittedChanges = {
  hasUncommittedChanges: boolean;
  uncommittedFiles: string[];
};

/**
 * Inspect a worktree at `worktreePath` and report whether its branch has
 * commits that aren't yet in the upstream base, plus whether the working
 * tree has uncommitted modifications.
 *
 * The returned `branchName` is whatever `git symbolic-ref HEAD` reports, or
 * `null` for a detached HEAD (or if the git invocation fails). All boolean
 * fields default to `false` in the failure path so a transient git error
 * never causes the UI to claim there are unmerged commits when it doesn't
 * actually know — a soft "I don't know" reads as "clean."
 *
 * Always returns `hasWorktree: true`. The caller is responsible for
 * checking that a worktree actually exists at the path; if it doesn't,
 * the agent-level "no worktree" empty status should be constructed
 * separately rather than calling this.
 */
export async function checkWorktreeStatus(
  worktreePath: string
): Promise<WorktreeStatus> {
  let branchName: string | null = null;
  let hasUnmergedCommits = false;
  let hasUncommittedChanges = false;
  let changedFiles: string[] = [];
  let uncommittedFiles: string[] = [];

  try {
    const branchResult = await runCommand(
      "git",
      ["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"],
      { allowedExitCodes: [0, 1] }
    );
    branchName =
      branchResult.exitCode === 0 && branchResult.stdout
        ? branchResult.stdout
        : null;
    const [unmerged, uncommitted] = await Promise.all([
      getUnmergedChanges(worktreePath),
      getUncommittedChanges(worktreePath),
    ]);
    hasUnmergedCommits = unmerged.hasUnmergedCommits;
    changedFiles = unmerged.changedFiles;
    hasUncommittedChanges = uncommitted.hasUncommittedChanges;
    uncommittedFiles = uncommitted.uncommittedFiles;
  } catch {
    // Worktree may have been manually removed
  }

  return {
    hasWorktree: true,
    hasUnmergedCommits,
    hasUncommittedChanges,
    worktreePath,
    branchName,
    changedFiles,
    uncommittedFiles,
  };
}

/**
 * Quick yes/no — does the worktree have either unmerged commits or
 * uncommitted changes? Used by the archive flow to decide whether to
 * preserve the worktree on disk rather than delete it.
 */
export async function hasOutstandingChanges(
  worktreePath: string
): Promise<boolean> {
  const [unmerged, uncommitted] = await Promise.all([
    getUnmergedChanges(worktreePath),
    getUncommittedChanges(worktreePath),
  ]);
  return unmerged.hasUnmergedCommits || uncommitted.hasUncommittedChanges;
}

/**
 * Determine whether the worktree's branch has commits that wouldn't
 * cleanly fold into its upstream base.
 *
 * Strategy: simulate `merge-tree HEAD <base>` and compare the resulting
 * tree against the base's tree. Identical trees mean everything on this
 * branch is already represented in the base — handles squash-merges,
 * rebases, and main moving forward with releases. Differing trees mean
 * the branch carries real changes; we then list them with `git diff`.
 *
 * Falls back through `@{upstream}` → `origin/main` → `main` for the base
 * ref. Returns `{ false, [] }` on any git failure (couldn't determine,
 * treat as clean).
 */
export async function getUnmergedChanges(
  worktreePath: string
): Promise<UnmergedChanges> {
  try {
    // Discover the upstream tracking branch (set at worktree creation time).
    // Falls back to origin/main for older worktrees that don't have one.
    let upstreamRef: string | null = null;
    try {
      const upstream = await runCommand(
        "git",
        ["-C", worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}"],
        { allowedExitCodes: [0, 128], timeoutMs: 5_000 }
      );
      if (upstream.exitCode === 0 && upstream.stdout) {
        upstreamRef = upstream.stdout;
      }
    } catch {
      // No upstream set — will fall back below
    }

    // Determine which remote branch to fetch
    const remoteBranch = upstreamRef?.startsWith("origin/")
      ? upstreamRef.slice("origin/".length)
      : "main";

    await runCommand(
      "git",
      ["-C", worktreePath, "fetch", "origin", remoteBranch, "--quiet"],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 15_000 }
    );

    // Resolve the base ref: prefer upstream, fall back to origin/main → main
    const baseRef =
      (upstreamRef ? await resolveRef(worktreePath, upstreamRef) : null) ??
      (await resolveRef(worktreePath, "origin/main")) ??
      (await resolveRef(worktreePath, "main"));
    if (!baseRef) {
      return { hasUnmergedCommits: false, changedFiles: [] };
    }

    // Simulate merging this branch into main. If the resulting tree is
    // identical to main's tree, everything on this branch is already in main
    // (handles squash-merges, rebases, and main moving forward with releases).
    const mergeTree = await runCommand(
      "git",
      ["-C", worktreePath, "merge-tree", "--write-tree", baseRef, "HEAD"],
      { allowedExitCodes: [0, 1], timeoutMs: 10_000 }
    );
    // merge-tree outputs the tree hash on the first line (exit 1 = conflicts)
    const resultTree = mergeTree.stdout.trim().split("\n")[0];
    const mainTree = await runCommand(
      "git",
      ["-C", worktreePath, "rev-parse", `${baseRef}^{tree}`],
      { allowedExitCodes: [0], timeoutMs: 5_000 }
    );

    if (resultTree === mainTree.stdout.trim()) {
      return { hasUnmergedCommits: false, changedFiles: [] };
    }

    // Trees differ — find which files the branch would actually change
    const fileDiff = await runCommand(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        "--name-only",
        mainTree.stdout.trim(),
        resultTree,
      ],
      { allowedExitCodes: [0], timeoutMs: 10_000 }
    );
    const changedFiles = fileDiff.stdout.trim().split("\n").filter(Boolean);

    return { hasUnmergedCommits: changedFiles.length > 0, changedFiles };
  } catch {
    return { hasUnmergedCommits: false, changedFiles: [] };
  }
}

/**
 * List uncommitted modifications in the worktree (staged, unstaged, and
 * untracked). Returns empty arrays on any git failure rather than
 * propagating the error — same soft-clean philosophy as
 * `getUnmergedChanges`.
 */
export async function getUncommittedChanges(
  worktreePath: string
): Promise<UncommittedChanges> {
  try {
    const status = await runCommand(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { allowedExitCodes: [0], timeoutMs: 10_000 }
    );
    const uncommittedFiles = status.stdout.trim().split("\n").filter(Boolean);

    return {
      hasUncommittedChanges: uncommittedFiles.length > 0,
      uncommittedFiles,
    };
  } catch {
    return { hasUncommittedChanges: false, uncommittedFiles: [] };
  }
}

/**
 * Verify a ref name exists in the worktree's repo. Returns the input ref
 * unchanged on success, `null` if `git rev-parse` can't resolve it.
 * Module-private — used as a fallback chain inside `getUnmergedChanges`.
 */
async function resolveRef(
  worktreePath: string,
  ref: string
): Promise<string | null> {
  const result = await runCommand(
    "git",
    ["-C", worktreePath, "rev-parse", "--verify", "--quiet", ref],
    { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
  );
  return result.exitCode === 0 && result.stdout.trim() ? ref : null;
}
