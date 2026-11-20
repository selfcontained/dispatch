import path from "node:path";

import type { AgentGitContext } from "../../agents/types.js";
import {
  runCommand as defaultRunCommand,
  type CommandRunner,
} from "../lib/run-command.js";
import { detectRepoIcon } from "../repo-icon.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;

export type ProbeOptions = {
  timeoutMs?: number;
  /** Runs git elsewhere, such as as a runner's workload identity. */
  commandRunner?: CommandRunner;
};

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
  const runCommand = opts.commandRunner ?? defaultRunCommand;

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
 * working tree; callers that need a domain-specific error should use
 * resolveCheckoutRootOrThrow.
 */
export async function resolveCheckoutRoot(
  cwd: string,
  commandRunner: CommandRunner = defaultRunCommand,
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

/**
 * resolveCheckoutRoot, rewrapping any failure as a 404 of the caller's
 * domain error class so HTTP/MCP error mapping keys off that class.
 */
export async function resolveCheckoutRootOrThrow(
  cwd: string,
  commandRunner: CommandRunner,
  ErrorClass: new (message: string, statusCode: number) => Error
): Promise<string> {
  try {
    return await resolveCheckoutRoot(cwd, commandRunner);
  } catch {
    throw new ErrorClass(
      "No git repository found for the provided working directory.",
      404
    );
  }
}

export async function resolveWorktreeRoot(
  cwd: string,
  opts: ProbeOptions = {}
): Promise<string> {
  return await resolveCheckoutRoot(cwd, defaultRunCommand, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
}

/**
 * Short name of the currently checked-out branch, or null when HEAD is
 * detached (or points at an empty/unborn ref).
 */
export async function resolveCurrentBranch(
  cwd: string,
  commandRunner: CommandRunner = defaultRunCommand,
  opts: ProbeOptions = {}
): Promise<string | null> {
  const result = await commandRunner(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
    { allowedExitCodes: [0, 1], timeoutMs: opts.timeoutMs }
  );

  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

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
  opts: ProbeOptions & { repoIcon?: boolean } = {}
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runCommand = opts.commandRunner ?? defaultRunCommand;
  try {
    const inside = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { allowedExitCodes: [0, 128], timeoutMs }
    );
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return { status: "ok", value: null };
    }

    const repoRoot = await resolveRepoRoot(cwd, {
      timeoutMs,
      commandRunner: runCommand,
    });
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

    const repoIconPath =
      opts.repoIcon === false ? null : await detectRepoIcon(checkoutRoot);

    return {
      status: "ok",
      value: gitContextFrom({
        repoRoot,
        branch,
        worktreePath: checkoutRoot,
        repoIconPath,
      }),
    };
  } catch {
    return { status: "error" };
  }
}

/**
 * Compose a gitContext for a Dispatch-managed worktree, deriving repoRoot
 * via a single git call. The branch is read live, since the agent may have
 * switched it; the recorded branch stands in when HEAD is detached or the
 * read fails.
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
    const liveBranch = await resolveCurrentBranch(worktreePath, undefined, {
      timeoutMs: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    }).catch(() => null);
    return {
      status: "ok",
      value: gitContextFrom({
        repoRoot,
        branch: liveBranch ?? worktreeBranch,
        worktreePath: normalizedWorktreePath,
        repoIconPath,
      }),
    };
  } catch {
    return { status: "error" };
  }
}
