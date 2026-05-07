import { runCommand, type RunCommandResult } from "../lib/run-command.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type ResolveBaseRefOptions = {
  /** Override for tests. */
  runCommand?: CommandRunner;
  /** When false, do not infer the target branch from @{upstream}. */
  allowUpstreamFallback?: boolean;
};

function normalizeBranchName(ref: string | null | undefined): string | null {
  const candidate = ref?.trim();
  if (!candidate || !isSafeRef(candidate)) return null;
  return candidate.startsWith("origin/")
    ? candidate.slice("origin/".length)
    : candidate;
}

async function resolveTargetBranch(
  run: CommandRunner,
  worktreePath: string,
  preferred: string | null | undefined,
  options: ResolveBaseRefOptions = {}
): Promise<string> {
  const preferredBranch = normalizeBranchName(preferred);
  if (preferredBranch) {
    return preferredBranch;
  }

  if (options.allowUpstreamFallback !== false) {
    try {
      const upstream = await run(
        "git",
        ["-C", worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}"],
        { allowedExitCodes: [0, 128], timeoutMs: 5_000 }
      );
      if (upstream.exitCode === 0) {
        const upstreamRef = upstream.stdout.trim();
        // Review diff refreshes only the origin tracking refs that Dispatch
        // worktrees are created against. Non-origin upstreams intentionally
        // fall through to the origin/main default below.
        if (upstreamRef.startsWith("origin/")) {
          const upstreamBranch = normalizeBranchName(upstreamRef);
          if (upstreamBranch) {
            return upstreamBranch;
          }
        }
      }
    } catch {
      // No upstream configured — fall through to origin/main.
    }
  }

  return "main";
}

function candidateRefsForBranch(branchName: string): string[] {
  if (branchName === "main") {
    return ["origin/main", "main"];
  }
  return [`origin/${branchName}`, branchName];
}

export async function refreshRemoteBaseRef(
  worktreePath: string,
  preferred: string | null | undefined,
  options: ResolveBaseRefOptions = {}
): Promise<void> {
  const run = options.runCommand ?? runCommand;
  const remoteBranch = await resolveTargetBranch(
    run,
    worktreePath,
    preferred,
    options
  );

  try {
    await run(
      "git",
      ["-C", worktreePath, "fetch", "origin", remoteBranch, "--quiet"],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 15_000 }
    );
  } catch {
    // Keep the existing local tracking refs as a fallback if refresh fails.
  }
}

/**
 * Resolve a usable base ref for the given worktree, applying the same
 * fallback chain used elsewhere in the agent flow:
 *
 *   1. `preferred` (e.g. `agent.baseBranch`) if it resolves
 *      Special case: prefer `origin/main` over local `main` so stale
 *      primary-checkout branches do not inflate worktree diff stats.
 *   2. the current branch's `@{upstream}` (unless disabled by the caller)
 *   3. `origin/main`
 *   4. `main`
 *
 * Returns the first ref that `git rev-parse --verify --quiet` accepts, or
 * `null` if none do. The function does NOT fetch from origin; callers that
 * need a fresh remote tip should fetch separately before calling. Centralising
 * the fallback here keeps base-ref behaviour consistent across the diff-stats
 * refresher and the worktree-status check.
 */
export async function resolveBaseRef(
  worktreePath: string,
  preferred: string | null | undefined,
  options: ResolveBaseRefOptions = {}
): Promise<string | null> {
  const run = options.runCommand ?? runCommand;
  const branchName = await resolveTargetBranch(
    run,
    worktreePath,
    preferred,
    options
  );
  for (const ref of candidateRefsForBranch(branchName)) {
    const found = await refExists(run, worktreePath, ref);
    if (found) return found;
  }

  return (
    (await refExists(run, worktreePath, "origin/main")) ??
    (await refExists(run, worktreePath, "main"))
  );
}

/**
 * Reject ref strings that could be mistaken for git options. We rely on
 * this guard plus the explicit `--` separator at the call site so a
 * crafted base-branch value (e.g. `--all`) can't reach git as a flag.
 */
function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-");
}

async function refExists(
  run: CommandRunner,
  worktreePath: string,
  ref: string
): Promise<string | null> {
  // The `isSafeRef` guard at every entry point keeps `-`-prefixed values
  // from reaching git as flags. We tried adding a `--` end-of-options
  // separator here as defense in depth, but `git rev-parse --verify`
  // refuses to resolve refs that follow `--` — so the safety check is
  // load-bearing on its own.
  if (!isSafeRef(ref)) return null;
  try {
    const result = await run(
      "git",
      ["-C", worktreePath, "rev-parse", "--verify", "--quiet", ref],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
    );
    return result.exitCode === 0 && result.stdout.trim() ? ref : null;
  } catch {
    return null;
  }
}
