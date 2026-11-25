export class GitWorktreeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "GitWorktreeError";
    this.statusCode = statusCode;
  }
}

/**
 * Canonical worktree bases are local branch names. Accept origin-qualified
 * input as an alias so fetching, persistence, and cleanup use the same name.
 * Nested origin/ aliases are unsupported so normalization stays idempotent.
 * Keep this separate from branch-name validation: an explicitly requested new
 * branch named origin/foo must retain that name.
 */
export function normalizeBaseBranch(value: string): string {
  const candidate = assertSafeRefName(value, "baseBranch");
  const branch = assertSafeRefName(
    candidate.startsWith("origin/")
      ? candidate.slice("origin/".length)
      : candidate,
    "baseBranch"
  );
  if (branch.startsWith("origin/")) {
    throw new GitWorktreeError(
      "baseBranch must not contain nested origin/ prefixes.",
      400
    );
  }
  if (branch.startsWith("-")) {
    throw new GitWorktreeError("baseBranch must not start with '-'.", 400);
  }
  return branch;
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

export type WorktreeStatus = {
  hasWorktree: boolean;
  ownership?: "owned" | "borrowed" | "external" | "none";
  borrowers?: string[];
  checkoutState?: string;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};
