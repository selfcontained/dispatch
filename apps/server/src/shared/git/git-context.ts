import path from "node:path";

import type { AgentGitContext } from "../../agents/types.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";
import { detectRepoIcon } from "../repo-icon.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;

export type ProbeOptions = { timeoutMs?: number };

export type ProbeResult =
  | { status: "ok"; value: AgentGitContext | null }
  | { status: "error" };

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : resolved;
}

export async function resolveRepoRoot(
  cwd: string,
  opts: ProbeOptions = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const commonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs }
  );
  if (commonDirResult.exitCode === 0 && commonDirResult.stdout) {
    const commonDir = normalizePath(commonDirResult.stdout);
    if (path.basename(commonDir) === ".git") {
      return normalizePath(path.dirname(commonDir));
    }
  }

  const fallbackCommonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs }
  );
  if (
    fallbackCommonDirResult.exitCode === 0 &&
    fallbackCommonDirResult.stdout
  ) {
    const commonDir = fallbackCommonDirResult.stdout;
    const absoluteCommonDir = normalizePath(
      path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)
    );
    if (path.basename(absoluteCommonDir) === ".git") {
      return normalizePath(path.dirname(absoluteCommonDir));
    }
  }

  return normalizePath(
    (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs,
      })
    ).stdout
  );
}

/**
 * Root of the current checkout (`--show-toplevel`) — for a linked worktree
 * this is the worktree path, not the main repository root. No timeout is
 * applied unless one is passed. Throws when `cwd` is not inside a git
 * working tree; callers that need a domain-specific error should rewrap.
 */
export async function resolveCheckoutRoot(
  cwd: string,
  commandRunner: CommandRunner = runCommand,
  opts: ProbeOptions = {}
): Promise<string> {
  return normalizePath(
    (
      await commandRunner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs: opts.timeoutMs,
      })
    ).stdout
  );
}

export async function resolveWorktreeRoot(
  cwd: string,
  opts: ProbeOptions = {}
): Promise<string> {
  return await resolveCheckoutRoot(cwd, runCommand, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
}

/**
 * Short name of the currently checked-out branch, or null when HEAD is
 * detached (or points at an empty/unborn ref).
 */
export async function resolveCurrentBranch(
  cwd: string,
  commandRunner: CommandRunner = runCommand,
  opts: ProbeOptions = {}
): Promise<string | null> {
  const result = await commandRunner(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
    { allowedExitCodes: [0, 1], timeoutMs: opts.timeoutMs }
  );

  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

/**
 * Single source of truth for "what does git think this directory is?".
 * Returns `{ status: "ok", value: null }` when the path isn't inside a git
 * working tree (legitimate non-error case for a non-worktree agent pointed
 * at a plain directory). Returns `{ status: "error" }` only when a probe
 * command fails outright — callers should log and continue rather than
 * blocking the surrounding lifecycle action.
 */
export async function probeGitContext(
  cwd: string,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const inside = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { allowedExitCodes: [0, 128], timeoutMs }
    );
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return { status: "ok", value: null };
    }

    const repoRoot = await resolveRepoRoot(cwd, { timeoutMs });
    const checkoutRoot = await resolveCheckoutRoot(cwd, runCommand, {
      timeoutMs,
    });

    let branch =
      (await resolveCurrentBranch(cwd, runCommand, { timeoutMs })) ?? "";
    if (!branch) {
      branch = (
        await runCommand("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
          allowedExitCodes: [0],
          timeoutMs,
        })
      ).stdout;
    }

    const repoIconPath = await detectRepoIcon(checkoutRoot);

    return {
      status: "ok",
      value: {
        repoRoot,
        branch,
        worktreePath: checkoutRoot,
        worktreeName: path.basename(checkoutRoot),
        isWorktree: checkoutRoot !== repoRoot,
        repoIconPath,
      },
    };
  } catch {
    return { status: "error" };
  }
}

/**
 * Compose a gitContext from row columns we already populated at creation,
 * deriving repoRoot via a single git call. Falls through to a full probe
 * when the row is missing the worktree fields (non-worktree agents) or
 * when repoRoot resolution itself fails.
 */
export async function buildGitContextForWorktree(input: {
  worktreePath: string;
  worktreeBranch: string;
  opts?: ProbeOptions;
}): Promise<ProbeResult> {
  const { worktreePath, worktreeBranch, opts } = input;
  try {
    const repoRoot = await resolveRepoRoot(worktreePath, opts);
    const normalizedWorktreePath = normalizePath(worktreePath);
    const repoIconPath = await detectRepoIcon(normalizedWorktreePath);
    return {
      status: "ok",
      value: {
        repoRoot,
        branch: worktreeBranch,
        worktreePath: normalizedWorktreePath,
        worktreeName: path.basename(normalizedWorktreePath),
        isWorktree: normalizedWorktreePath !== repoRoot,
        repoIconPath,
      },
    };
  } catch {
    return { status: "error" };
  }
}
