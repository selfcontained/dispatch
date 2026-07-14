import { resolveBaseRef } from "./base-ref.js";
import { readUntrackedFile, shouldExcludePath } from "./diff-file-rules.js";
import { runCommand, type RunCommandResult } from "../lib/run-command.js";

export type DiffStats = {
  added: number;
  deleted: number;
  files: number;
  computedAt: number;
};

const GIT_TIMEOUT_MS = 15_000;

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type GetDiffStatsOptions = {
  /** Override for tests. */
  runCommand?: CommandRunner;
  /** Include staged, unstaged, and untracked working-tree changes. */
  includeUncommitted?: boolean;
};

/**
 * Compute a GitHub-PR-style summary of the diff between an agent's worktree
 * and its base branch.
 *
 * Strategy: resolve the base ref (with the same fallback chain the rest of
 * the agent flow uses), find the merge-base with HEAD, then take a single
 * `git diff <merge-base> --numstat`. That single diff captures committed,
 * staged, and unstaged tracked-file changes as one net result, so a file
 * edited in commits AND in the working tree contributes its true combined
 * line count rather than the committed-only slice. Untracked new files are
 * layered on top by counting their lines directly.
 *
 * Returns `null` when no base ref resolves or git fails outright. Returns
 * zeros when the worktree is genuinely clean. Binary files (and untracked
 * files larger than 1MB) contribute to the file count but not to the line
 * counts — same convention GitHub uses.
 */
export async function getDiffStats(
  worktreePath: string,
  baseRef: string | null,
  options: GetDiffStatsOptions = {}
): Promise<DiffStats | null> {
  const run = options.runCommand ?? runCommand;
  const includeUncommitted = options.includeUncommitted !== false;
  try {
    const resolvedBase = await resolveBaseRef(worktreePath, baseRef, {
      runCommand: run,
    });
    if (!resolvedBase) return null;

    const mergeBase = await run(
      "git",
      ["-C", worktreePath, "merge-base", "HEAD", resolvedBase],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
    );
    if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) {
      return null;
    }
    const mergeBaseSha = mergeBase.stdout.trim();

    const diffRange = includeUncommitted
      ? [mergeBaseSha]
      : [mergeBaseSha, "HEAD"];
    const [tracked, untracked] = await Promise.all([
      run("git", ["-C", worktreePath, "diff", ...diffRange, "--numstat"], {
        allowedExitCodes: [0],
        timeoutMs: GIT_TIMEOUT_MS,
      }),
      includeUncommitted
        ? run(
            "git",
            ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"],
            { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
          )
        : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    ]);

    const trackedPaths = extractPathsFromNumstat(tracked.stdout);
    const ignoredPaths = await getGitIgnoredPaths(
      worktreePath,
      trackedPaths,
      run
    );

    let added = 0;
    let deleted = 0;
    const seenFiles = new Set<string>();

    for (const line of tracked.stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [a, d, ...rest] = parts;
      const filePath = rest.join("\t");
      if (!filePath) continue;
      if (shouldExcludePath(filePath)) continue;
      if (ignoredPaths.has(filePath)) continue;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      if (a === "-" && d === "-") continue;
      added += Number.parseInt(a, 10) || 0;
      deleted += Number.parseInt(d, 10) || 0;
    }

    for (const filePath of untracked.stdout.split("\n")) {
      if (!filePath) continue;
      if (shouldExcludePath(filePath)) continue;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const { lines } = await readUntrackedFile(worktreePath, filePath);
      added += lines;
    }

    return {
      added,
      deleted,
      files: seenFiles.size,
      computedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function extractPathsFromNumstat(numstatOutput: string): string[] {
  const paths: string[] = [];
  for (const line of numstatOutput.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const filePath = parts.slice(2).join("\t");
    if (filePath) paths.push(filePath);
  }
  return paths;
}

const CHECK_IGNORE_BATCH_SIZE = 500;

async function getGitIgnoredPaths(
  worktreePath: string,
  paths: string[],
  run: CommandRunner
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const ignored = new Set<string>();
  try {
    for (let i = 0; i < paths.length; i += CHECK_IGNORE_BATCH_SIZE) {
      const batch = paths.slice(i, i + CHECK_IGNORE_BATCH_SIZE);
      const result = await run(
        "git",
        ["-C", worktreePath, "check-ignore", "--", ...batch],
        { allowedExitCodes: [0, 1], timeoutMs: GIT_TIMEOUT_MS }
      );
      if (result.exitCode === 0 && result.stdout) {
        for (const p of result.stdout.split("\n")) {
          if (p) ignored.add(p);
        }
      }
    }
    return ignored;
  } catch {
    return ignored;
  }
}
