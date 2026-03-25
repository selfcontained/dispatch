import path from "node:path";
import { access } from "node:fs/promises";

import { runCommand, type RunCommandResult } from "../lib/run-command.js";

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
  const branchName = normalizeRefName(input.branchName, slugify(name), "branchName");
  const worktreePath = input.worktreePath?.trim()
    ? path.resolve(input.worktreePath)
    : path.resolve(repoRoot, "..", `${path.basename(repoRoot)}-${slugify(branchName)}`);

  if (normalizePath(worktreePath) === normalizePath(repoRoot)) {
    throw new GitWorktreeError("worktree path must differ from the repository root.", 400);
  }

  await ensurePathDoesNotExist(worktreePath);

  const updateBase = input.updateBase ?? true;
  const baseRef = updateBase ? `origin/${baseBranch}` : baseBranch;

  if (updateBase) {
    await commandRunner("git", ["-C", repoRoot, "fetch", "origin", baseBranch, "--quiet"]);
    await ensureGitRefExists(repoRoot, baseRef, commandRunner);
  } else {
    await ensureGitRefExists(repoRoot, baseRef, commandRunner);
  }

  const baseSha = await resolveGitRef(repoRoot, baseRef, commandRunner);

  await ensureBranchDoesNotExist(repoRoot, branchName, commandRunner);

  await commandRunner("git", [
    "-C", repoRoot,
    "worktree", "add",
    "-b", branchName,
    worktreePath,
    baseRef
  ]);

  return {
    repoRoot,
    worktreePath,
    worktreeName: path.basename(worktreePath),
    branchName,
    baseBranch,
    baseRef,
    baseSha
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
    throw new GitWorktreeError("cleanup-worktree only removes linked worktrees, not the primary checkout.", 400);
  }

  const baseBranch = normalizeRefName(input.baseBranch, "main", "baseBranch");
  const branchName = await resolveCurrentBranch(worktreePath, commandRunner);

  let updatedBaseBranch = false;
  if (input.updateBaseBranch ?? false) {
    await ensurePrimaryCheckoutCanUpdate(repoRoot, baseBranch, commandRunner);
    await commandRunner("git", ["-C", repoRoot, "fetch", "origin", baseBranch, "--quiet"]);
    await commandRunner("git", ["-C", repoRoot, "pull", "--ff-only", "origin", baseBranch]);
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
      "-C", repoRoot,
      "branch",
      input.force ? "-D" : "--delete",
      branchName
    ]);
    deletedBranch = true;
  }

  return {
    repoRoot,
    worktreePath,
    worktreeName: path.basename(worktreePath),
    branchName,
    baseBranch,
    updatedBaseBranch,
    deletedBranch
  };
}

async function resolveRepoRoot(cwd: string, commandRunner: CommandRunner): Promise<string> {
  try {
    return normalizePath(
      (
        await commandRunner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          allowedExitCodes: [0]
        })
      ).stdout
    );
  } catch {
    throw new GitWorktreeError("No git repository found for the provided working directory.", 404);
  }
}

async function resolveCurrentCheckoutRoot(cwd: string, commandRunner: CommandRunner): Promise<string> {
  return await resolveRepoRoot(cwd, commandRunner);
}

async function resolveCommonRepoRoot(cwd: string, commandRunner: CommandRunner): Promise<string> {
  const commonDir = (
    await commandRunner("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).stdout;

  const absoluteCommonDir = normalizePath(commonDir);
  if (path.basename(absoluteCommonDir) !== ".git") {
    throw new GitWorktreeError("Unable to resolve the repository root for this worktree.", 500);
  }

  return normalizePath(path.dirname(absoluteCommonDir));
}

async function resolveCurrentBranch(cwd: string, commandRunner: CommandRunner): Promise<string | null> {
  const result = await commandRunner(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
    { allowedExitCodes: [0, 1] }
  );

  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

async function resolveGitRef(repoRoot: string, ref: string, commandRunner: CommandRunner): Promise<string> {
  return (
    await commandRunner("git", ["-C", repoRoot, "rev-parse", "--verify", ref], {
      allowedExitCodes: [0]
    })
  ).stdout;
}

async function ensureGitRefExists(repoRoot: string, ref: string, commandRunner: CommandRunner): Promise<void> {
  const result = await commandRunner(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", ref],
    { allowedExitCodes: [0, 128] }
  );

  if (result.exitCode !== 0) {
    throw new GitWorktreeError(`Git ref "${ref}" was not found in ${repoRoot}.`, 404);
  }
}

async function ensureBranchDoesNotExist(repoRoot: string, branchName: string, commandRunner: CommandRunner): Promise<void> {
  const localBranch = await commandRunner(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { allowedExitCodes: [0, 1] }
  );
  if (localBranch.exitCode === 0) {
    throw new GitWorktreeError(`Local branch "${branchName}" already exists.`, 409);
  }

  const remoteBranch = await commandRunner(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    { allowedExitCodes: [0, 1] }
  );
  if (remoteBranch.exitCode === 0) {
    throw new GitWorktreeError(`Remote branch "origin/${branchName}" already exists.`, 409);
  }
}

async function ensureBranchExists(repoRoot: string, branchName: string, commandRunner: CommandRunner): Promise<void> {
  const result = await commandRunner(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { allowedExitCodes: [0, 1] }
  );

  if (result.exitCode !== 0) {
    throw new GitWorktreeError(`Local branch "${branchName}" no longer exists.`, 404);
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

  const status = await commandRunner("git", ["-C", repoRoot, "status", "--porcelain"]);
  if (status.stdout) {
    throw new GitWorktreeError(
      `Primary checkout at ${repoRoot} has uncommitted changes. Refusing to update "${baseBranch}".`,
      409
    );
  }
}

async function ensurePathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await access(targetPath);
    throw new GitWorktreeError(`Target worktree path already exists: ${targetPath}`, 409);
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      throw error;
    }
  }
}

function normalizeRefName(value: string | undefined, fallback: string, fieldName: string): string {
  const normalized = (value?.trim() || fallback).trim();
  if (!normalized) {
    throw new GitWorktreeError(`${fieldName} must not be empty.`, 400);
  }

  if (/\s/.test(normalized)) {
    throw new GitWorktreeError(`${fieldName} must not contain whitespace.`, 400);
  }

  return normalized;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug) {
    throw new GitWorktreeError("Unable to derive a valid worktree name from the provided input.", 400);
  }

  return slug;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "");
}
