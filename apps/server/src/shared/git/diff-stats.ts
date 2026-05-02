import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { runCommand, type RunCommandResult } from "../lib/run-command.js";

export type DiffStats = {
  added: number;
  deleted: number;
  files: number;
  computedAt: number;
};

const UNTRACKED_LINE_COUNT_MAX_BYTES = 1_000_000;
const GIT_TIMEOUT_MS = 15_000;
const BINARY_PROBE_BYTES = 8 * 1024;

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type GetDiffStatsOptions = {
  /** Override for tests. */
  runCommand?: CommandRunner;
};

/**
 * Compute a GitHub-PR-style summary of the diff between an agent's worktree
 * and its base branch — committed changes (merge-base..HEAD), uncommitted
 * changes (staged + unstaged vs HEAD), and untracked new files.
 *
 * Returns `null` when the base ref can't be resolved or git fails outright.
 * Returns zeros when the worktree is genuinely clean. Binary files (and
 * untracked files larger than 1MB) contribute to the file count but not to
 * the line counts — same convention GitHub uses.
 */
export async function getDiffStats(
  worktreePath: string,
  baseRef: string,
  options: GetDiffStatsOptions = {}
): Promise<DiffStats | null> {
  const run = options.runCommand ?? runCommand;
  try {
    const baseCheck = await run(
      "git",
      ["-C", worktreePath, "rev-parse", "--verify", "--quiet", baseRef],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
    );
    if (baseCheck.exitCode !== 0 || !baseCheck.stdout.trim()) {
      return null;
    }

    const [committed, uncommitted, untracked] = await Promise.all([
      run(
        "git",
        ["-C", worktreePath, "diff", `${baseRef}...HEAD`, "--numstat"],
        { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
      ),
      run("git", ["-C", worktreePath, "diff", "HEAD", "--numstat"], {
        allowedExitCodes: [0],
        timeoutMs: GIT_TIMEOUT_MS,
      }),
      run(
        "git",
        ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"],
        { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
      ),
    ]);

    let added = 0;
    let deleted = 0;
    const seenFiles = new Set<string>();

    for (const result of [committed, uncommitted]) {
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const [a, d, ...rest] = parts;
        const filePath = rest.join("\t");
        if (!filePath) continue;
        if (seenFiles.has(filePath)) continue;
        seenFiles.add(filePath);
        if (a === "-" && d === "-") continue;
        added += Number.parseInt(a, 10) || 0;
        deleted += Number.parseInt(d, 10) || 0;
      }
    }

    for (const filePath of untracked.stdout.split("\n")) {
      if (!filePath) continue;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const lines = await countUntrackedLines(worktreePath, filePath);
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

async function countUntrackedLines(
  worktreePath: string,
  filePath: string
): Promise<number> {
  const fullPath = path.join(worktreePath, filePath);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) return 0;
    if (info.size === 0) return 0;
    if (info.size > UNTRACKED_LINE_COUNT_MAX_BYTES) return 0;
    const buffer = await readFile(fullPath);
    if (looksBinary(buffer)) return 0;
    return countLines(buffer.toString("utf8"));
  } catch {
    return 0;
  }
}

function looksBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < probeLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}
