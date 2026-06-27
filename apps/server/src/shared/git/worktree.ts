import path from "node:path";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

import { runCommand, type RunCommandResult } from "../lib/run-command.js";

/**
 * Build a worktree-path slug from a branch name. When the worktree is being
 * created on an existing branch (createNewBranch=false), the slug includes a
 * short hash of the full ref so that branches that differ only in
 * non-alphanumeric punctuation (`feature/x` vs `feature-x`, `release/2026.04`
 * vs `release-2026-04`) don't collapse to the same on-disk path.
 */
export function worktreePathSlug(
  branchName: string,
  options: { createNewBranch: boolean }
): string {
  const baseSlug = slugify(branchName);
  if (options.createNewBranch) {
    return baseSlug;
  }
  const hash = createHash("sha1").update(branchName).digest("hex").slice(0, 6);
  return `${baseSlug}-${hash}`;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type CreateGitWorktreeInput = {
  cwd: string;
  name: string;
  branchName?: string;
  baseBranch?: string;
  updateBase?: boolean;
  worktreePath?: string;
  /**
   * When true, fork a new branch from `baseBranch` (named `branchName` or a
   * slug of `name`) and check it out in the worktree. When false (default),
   * check out `baseBranch` directly without creating a new branch — the
   * result's `branchName` will be the base branch. Defaults to false so
   * direct callers don't get implicit branch creation; the agent manager
   * sets it explicitly to preserve its own authoring-flow default of true.
   */
  createNewBranch?: boolean;
};

export type CreateGitWorktreeResult = {
  repoRoot: string;
  worktreePath: string;
  worktreeName: string;
  branchName: string;
  baseBranch: string;
  baseRef: string;
  baseSha: string;
};

export type CleanupGitWorktreeInput = {
  cwd: string;
  baseBranch?: string;
  updateBaseBranch?: boolean;
  deleteBranch?: boolean;
  force?: boolean;
  /** The branch originally created for this worktree (from DB). If the agent
   *  switched branches, this may differ from the current HEAD branch. When set
   *  and different from the current branch, cleanup will also delete it — but
   *  only if it has no commits beyond its upstream (no work to lose). */
  originalBranch?: string | null;
};

export type CleanupGitWorktreeResult = {
  repoRoot: string;
  worktreePath: string;
  worktreeName: string;
  branchName: string | null;
  baseBranch: string;
  updatedBaseBranch: boolean;
  deletedBranch: boolean;
};

export class GitWorktreeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "GitWorktreeError";
    this.statusCode = statusCode;
  }
}

export async function resolveHeadSha(cwd: string): Promise<string | null> {
  try {
    const result = await runCommand("git", ["-C", cwd, "rev-parse", "HEAD"], {
      allowedExitCodes: [0, 128],
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function createGitWorktree(
  input: CreateGitWorktreeInput,
  commandRunner: CommandRunner = runCommand
): Promise<CreateGitWorktreeResult> {
  const cwd = input.cwd.trim();
  if (!cwd) {
    throw new GitWorktreeError("cwd is required.", 400);
  }

  const name = input.name.trim();
  if (!name) {
    throw new GitWorktreeError("name is required.", 400);
  }

  const repoRoot = await resolveRepoRoot(cwd, commandRunner);
  const baseBranch = normalizeRefName(input.baseBranch, "main", "baseBranch");
  const createNewBranch = input.createNewBranch ?? false;
  const branchName = createNewBranch
    ? normalizeRefName(input.branchName, slugify(name), "branchName")
    : baseBranch;
  const worktreePathSlugBase = createNewBranch ? branchName : baseBranch;
  const worktreePath = input.worktreePath?.trim()
    ? path.resolve(input.worktreePath)
    : path.resolve(
        repoRoot,
        "..",
        `${path.basename(repoRoot)}-${worktreePathSlug(worktreePathSlugBase, { createNewBranch })}`
      );

  if (normalizePath(worktreePath) === normalizePath(repoRoot)) {
    throw new GitWorktreeError(
      "worktree path must differ from the repository root.",
      400
    );
  }

  await ensurePathDoesNotExist(worktreePath);

  const updateBase = input.updateBase ?? true;
  let baseRef = updateBase ? `origin/${baseBranch}` : baseBranch;

  if (updateBase) {
    const hasOrigin = await hasRemote(repoRoot, "origin", commandRunner);
    if (hasOrigin) {
      await commandRunner("git", [
        "-C",
        repoRoot,
        "fetch",
        "origin",
        baseBranch,
        "--quiet",
      ]);
    } else {
      baseRef = baseBranch;
    }
  }
  await ensureGitRefExists(repoRoot, baseRef, commandRunner);

  const baseSha = await resolveGitRef(repoRoot, baseRef, commandRunner);

  if (createNewBranch) {
    await ensureBranchDoesNotExist(repoRoot, branchName, commandRunner);

    await commandRunner("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      baseRef,
    ]);

    // Set upstream tracking so archival checks know which branch to compare against
    await commandRunner(
      "git",
      ["-C", worktreePath, "branch", "--set-upstream-to", baseRef, branchName],
      { allowedExitCodes: [0, 1, 128] }
    );
  } else {
    // Check out the starting branch directly. Use the local branch so git
    // creates/updates the worktree on the user-facing ref rather than a
    // detached origin/* ref.
    await commandRunner("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      worktreePath,
      baseBranch,
    ]);
  }

  return {
    repoRoot,
    worktreePath,
    worktreeName: path.basename(worktreePath),
    branchName,
    baseBranch,
    baseRef,
    baseSha,
  };
}

export async function cleanupGitWorktree(
  input: CleanupGitWorktreeInput,
  commandRunner: CommandRunner = runCommand
): Promise<CleanupGitWorktreeResult> {
  const cwd = input.cwd.trim();
  if (!cwd) {
    throw new GitWorktreeError("cwd is required.", 400);
  }

  const worktreePath = await resolveCurrentCheckoutRoot(cwd, commandRunner);
  const repoRoot = await resolveCommonRepoRoot(worktreePath, commandRunner);
  const normalizedWorktreePath = normalizePath(worktreePath);
  const normalizedRepoRoot = normalizePath(repoRoot);

  if (normalizedWorktreePath === normalizedRepoRoot) {
    throw new GitWorktreeError(
      "cleanup-worktree only removes linked worktrees, not the primary checkout.",
      400
    );
  }

  const baseBranch = normalizeRefName(input.baseBranch, "main", "baseBranch");
  const branchName = await resolveCurrentBranch(worktreePath, commandRunner);

  let updatedBaseBranch = false;
  if (input.updateBaseBranch ?? false) {
    await ensurePrimaryCheckoutCanUpdate(repoRoot, baseBranch, commandRunner);
    await commandRunner("git", [
      "-C",
      repoRoot,
      "fetch",
      "origin",
      baseBranch,
      "--quiet",
    ]);
    await commandRunner("git", [
      "-C",
      repoRoot,
      "pull",
      "--ff-only",
      "origin",
      baseBranch,
    ]);
    updatedBaseBranch = true;
  }

  const worktreeRemoveArgs = ["-C", repoRoot, "worktree", "remove"];
  if (input.force ?? false) {
    worktreeRemoveArgs.push("--force");
  }
  worktreeRemoveArgs.push(worktreePath);
  await commandRunner("git", worktreeRemoveArgs);

  let deletedBranch = false;
  if ((input.deleteBranch ?? false) && branchName) {
    await ensureBranchExists(repoRoot, branchName, commandRunner);
    await commandRunner("git", [
      "-C",
      repoRoot,
      "branch",
      input.force ? "-D" : "--delete",
      branchName,
    ]);
    deletedBranch = true;
  }

  // If the agent switched branches, the originally-created worktree branch
  // is still sitting around. Delete it too, but only if it has zero commits
  // ahead of its upstream so we never destroy actual work.
  const originalBranch = input.originalBranch?.trim() || null;
  if (
    originalBranch &&
    originalBranch !== branchName &&
    (input.deleteBranch ?? false)
  ) {
    const exists = await commandRunner(
      "git",
      [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${originalBranch}`,
      ],
      { allowedExitCodes: [0, 1] }
    );
    if (exists.exitCode === 0) {
      const ahead = await commandRunner(
        "git",
        [
          "-C",
          repoRoot,
          "rev-list",
          "--count",
          `${originalBranch}@{upstream}..${originalBranch}`,
        ],
        { allowedExitCodes: [0, 128] }
      );
      const commitCount = parseInt(ahead.stdout || "0", 10);
      if (ahead.exitCode === 0 && commitCount === 0) {
        await commandRunner("git", [
          "-C",
          repoRoot,
          "branch",
          "-d",
          originalBranch,
        ]);
      }
    }
  }

  return {
    repoRoot,
    worktreePath,
    worktreeName: path.basename(worktreePath),
    branchName,
    baseBranch,
    updatedBaseBranch,
    deletedBranch,
  };
}

async function resolveRepoRoot(
  cwd: string,
  commandRunner: CommandRunner
): Promise<string> {
  try {
    return normalizePath(
      (
        await commandRunner(
          "git",
          ["-C", cwd, "rev-parse", "--show-toplevel"],
          {
            allowedExitCodes: [0],
          }
        )
      ).stdout
    );
  } catch {
    throw new GitWorktreeError(
      "No git repository found for the provided working directory.",
      404
    );
  }
}

async function resolveCurrentCheckoutRoot(
  cwd: string,
  commandRunner: CommandRunner
): Promise<string> {
  return await resolveRepoRoot(cwd, commandRunner);
}

async function resolveCommonRepoRoot(
  cwd: string,
  commandRunner: CommandRunner
): Promise<string> {
  const commonDir = (
    await commandRunner("git", [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).stdout;

  const absoluteCommonDir = normalizePath(commonDir);
  if (path.basename(absoluteCommonDir) !== ".git") {
    throw new GitWorktreeError(
      "Unable to resolve the repository root for this worktree.",
      500
    );
  }

  return normalizePath(path.dirname(absoluteCommonDir));
}

async function resolveCurrentBranch(
  cwd: string,
  commandRunner: CommandRunner
): Promise<string | null> {
  const result = await commandRunner(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
    { allowedExitCodes: [0, 1] }
  );

  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

async function resolveGitRef(
  repoRoot: string,
  ref: string,
  commandRunner: CommandRunner
): Promise<string> {
  return (
    await commandRunner("git", ["-C", repoRoot, "rev-parse", "--verify", ref], {
      allowedExitCodes: [0],
    })
  ).stdout;
}

async function ensureGitRefExists(
  repoRoot: string,
  ref: string,
  commandRunner: CommandRunner
): Promise<void> {
  const result = await commandRunner(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", ref],
    { allowedExitCodes: [0, 128] }
  );

  if (result.exitCode !== 0) {
    throw new GitWorktreeError(
      `Git ref "${ref}" was not found in ${repoRoot}.`,
      404
    );
  }
}

async function ensureBranchDoesNotExist(
  repoRoot: string,
  branchName: string,
  commandRunner: CommandRunner
): Promise<void> {
  const localBranch = await commandRunner(
    "git",
    [
      "-C",
      repoRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ],
    { allowedExitCodes: [0, 1] }
  );
  if (localBranch.exitCode === 0) {
    throw new GitWorktreeError(
      `Local branch "${branchName}" already exists.`,
      409
    );
  }

  const remoteBranch = await commandRunner(
    "git",
    [
      "-C",
      repoRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branchName}`,
    ],
    { allowedExitCodes: [0, 1] }
  );
  if (remoteBranch.exitCode === 0) {
    throw new GitWorktreeError(
      `Remote branch "origin/${branchName}" already exists.`,
      409
    );
  }
}

async function ensureBranchExists(
  repoRoot: string,
  branchName: string,
  commandRunner: CommandRunner
): Promise<void> {
  const result = await commandRunner(
    "git",
    [
      "-C",
      repoRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ],
    { allowedExitCodes: [0, 1] }
  );

  if (result.exitCode !== 0) {
    throw new GitWorktreeError(
      `Local branch "${branchName}" no longer exists.`,
      404
    );
  }
}

async function ensurePrimaryCheckoutCanUpdate(
  repoRoot: string,
  baseBranch: string,
  commandRunner: CommandRunner
): Promise<void> {
  const currentBranch = await resolveCurrentBranch(repoRoot, commandRunner);
  if (currentBranch !== baseBranch) {
    throw new GitWorktreeError(
      `Primary checkout is on "${currentBranch ?? "detached HEAD"}", not "${baseBranch}". Refusing to update it automatically.`,
      409
    );
  }

  const status = await commandRunner("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain",
  ]);
  if (status.stdout) {
    throw new GitWorktreeError(
      `Primary checkout at ${repoRoot} has uncommitted changes. Refusing to update "${baseBranch}".`,
      409
    );
  }
}

async function hasRemote(
  repoRoot: string,
  remoteName: string,
  commandRunner: CommandRunner
): Promise<boolean> {
  // exit 2 = remote doesn't exist; other non-zero exits or spawn failures propagate
  const result = await commandRunner(
    "git",
    ["-C", repoRoot, "remote", "get-url", remoteName],
    { allowedExitCodes: [0, 2] }
  );
  return result.exitCode === 0;
}

async function ensurePathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await access(targetPath);
    throw new GitWorktreeError(
      `Target worktree path already exists: ${targetPath}`,
      409
    );
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      throw error;
    }
  }
}

function normalizeRefName(
  value: string | undefined,
  fallback: string,
  fieldName: string
): string {
  const candidate = (value?.trim() || fallback).trim();
  return assertSafeRefName(candidate, fieldName);
}

/**
 * Trim a ref name and ensure it only contains characters that are both valid
 * in git ref names and safe to interpolate into a shell command (so callers
 * that splice the result into bash, env vars, etc. don't have to do their own
 * escaping). Throws `GitWorktreeError(400)` on whitespace, shell
 * metacharacters, or other unsafe input. Callers that already know the value
 * is non-empty should pass it through here before persisting or interpolating.
 */
export function assertSafeRefName(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GitWorktreeError(`${fieldName} must not be empty.`, 400);
  }
  // Allow letters, digits, '_', '.', '-', and '/'. This is a strict subset of
  // git's own ref-name rules and rules out every shell metacharacter (";",
  // "\"", "'", "$", backtick, "&", "|", "(", ")", "<", ">", whitespace, etc.).
  if (!/^[\w./-]+$/.test(trimmed)) {
    throw new GitWorktreeError(
      `${fieldName} may only contain letters, digits, '.', '_', '-', or '/'.`,
      400
    );
  }
  return trimmed;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug) {
    throw new GitWorktreeError(
      "Unable to derive a valid worktree name from the provided input.",
      400
    );
  }

  return slug;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "");
}
