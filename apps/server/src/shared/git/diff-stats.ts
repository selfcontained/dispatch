import type { DiffStats, DiffTotals } from "@dispatch/shared";

import { resolveBaseRef } from "./base-ref.js";
import {
  readUntrackedFile,
  resolveRenamePath,
  shouldExcludePath,
} from "./diff-file-rules.js";
import { isTestFile } from "./test-files.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";

// The diff stats shape is a contract with the web client, so it lives in
// @dispatch/shared. Re-exported here because this module is where the rest of
// the server reaches for it.
export type { DiffStats, DiffTotals } from "@dispatch/shared";

export type DiffStatsComputation =
  | { kind: "success"; stats: DiffStats }
  | { kind: "no-data"; stats: null }
  | { kind: "partial"; stats: DiffStats; error: unknown }
  | { kind: "failure"; stats: null; error: unknown };

const GIT_TIMEOUT_MS = 15_000;

export type GetDiffStatsOptions = {
  /** Override for tests. */
  runCommand?: CommandRunner;
  /** Include staged, unstaged, and untracked working-tree changes. */
  includeUncommitted?: boolean;
  /** Receives command/probe failures while the public result remains null. */
  onError?: (error: unknown) => void;
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
  const result = await getDiffStatsComputation(worktreePath, baseRef, options);
  return result.stats;
}

/**
 * Internal, discriminated form used by observability-aware callers. It keeps
 * best-effort probe failures distinct from fatal Git failures without changing
 * the public getDiffStats null/usable-stats contract.
 */
export async function getDiffStatsComputation(
  worktreePath: string,
  baseRef: string | null,
  options: GetDiffStatsOptions = {}
): Promise<DiffStatsComputation> {
  const run = options.runCommand ?? runCommand;
  const includeUncommitted = options.includeUncommitted !== false;
  const probeErrors: unknown[] = [];
  const recordError = (error: unknown) => {
    probeErrors.push(error);
    options.onError?.(error);
  };
  try {
    const resolvedBase = await resolveBaseRef(worktreePath, baseRef, {
      runCommand: run,
      onError: recordError,
    });
    if (!resolvedBase) {
      return probeErrors.length > 0
        ? { kind: "failure", stats: null, error: probeErrors[0] }
        : { kind: "no-data", stats: null };
    }

    const mergeBase = await run(
      "git",
      ["-C", worktreePath, "merge-base", "HEAD", resolvedBase],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
    );
    if (mergeBase.exitCode === 128) {
      const error = new Error("Git merge-base failed");
      recordError(error);
      return { kind: "failure", stats: null, error };
    }
    if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) {
      return { kind: "no-data", stats: null };
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
      run,
      recordError
    );

    let added = 0;
    let deleted = 0;
    const excludingTests: DiffTotals = { added: 0, deleted: 0, files: 0 };
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
      // Classify by where the file ends up, not by git's brace-compressed
      // rename string — `src/{lib => test}/helper.ts` matches no directory
      // rule as written, while the Changes tab is deciding about
      // `src/test/helper.ts`. Only this decision uses the resolved path;
      // `seenFiles` and `shouldExcludePath` stay on the raw one so the
      // unfiltered totals keep counting exactly what they counted before.
      const countsAsTest = isTestFile(resolveRenamePath(filePath).dest);
      if (!countsAsTest) excludingTests.files += 1;
      if (a === "-" && d === "-") continue;
      const fileAdded = Number.parseInt(a, 10) || 0;
      const fileDeleted = Number.parseInt(d, 10) || 0;
      added += fileAdded;
      deleted += fileDeleted;
      if (!countsAsTest) {
        excludingTests.added += fileAdded;
        excludingTests.deleted += fileDeleted;
      }
    }

    for (const filePath of untracked.stdout.split("\n")) {
      if (!filePath) continue;
      if (shouldExcludePath(filePath)) continue;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const { lines } = await readUntrackedFile(worktreePath, filePath);
      added += lines;
      if (!isTestFile(filePath)) {
        excludingTests.files += 1;
        excludingTests.added += lines;
      }
    }

    const stats = {
      added,
      deleted,
      files: seenFiles.size,
      excludingTests,
      computedAt: Date.now(),
    };
    return probeErrors.length > 0
      ? { kind: "partial", stats, error: probeErrors[0] }
      : { kind: "success", stats };
  } catch (error) {
    recordError(error);
    return { kind: "failure", stats: null, error };
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
  run: CommandRunner,
  onError?: (error: unknown) => void
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
  } catch (error) {
    onError?.(error);
    return ignored;
  }
}
