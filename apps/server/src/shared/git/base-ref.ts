import { runCommand, type RunCommandResult } from "../lib/run-command.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type ResolveBaseRefOptions = {
  /** Override for tests. */
  runCommand?: CommandRunner;
};

/**
 * Resolve a usable base ref for the given worktree, applying the same
 * fallback chain used elsewhere in the agent flow:
 *
 *   1. `preferred` (e.g. `agent.baseBranch`) if it resolves
 *   2. the current branch's `@{upstream}`
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

  if (preferred && preferred.trim()) {
    const candidate = preferred.trim();
    if (isSafeRef(candidate)) {
      const found = await refExists(run, worktreePath, candidate);
      if (found) return found;
    }
  }

  try {
    const upstream = await run(
      "git",
      ["-C", worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}"],
      { allowedExitCodes: [0, 128], timeoutMs: 5_000 }
    );
    if (upstream.exitCode === 0) {
      const trimmed = upstream.stdout.trim();
      if (trimmed && isSafeRef(trimmed)) {
        const found = await refExists(run, worktreePath, trimmed);
        if (found) return found;
      }
    }
  } catch {
    // No upstream configured — fall through to the origin/main / main chain.
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
