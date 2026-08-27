type RunCommandResult = {
  stdout: string;
};

type RunCommandFn = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<RunCommandResult>;

function trimTrailingWhitespace(value: string): string {
  return value.replace(/\s+$/u, "");
}

/**
 * A file-level map of the review target — never the diff itself.
 *
 * Reviewers run in the worktree (`dispatch_launch_persona` uses the
 * parent's cwd), so they can read any hunk they want with the git
 * commands the prompt hands them. Embedding the diff bought nothing a
 * `git diff` couldn't, went stale the moment it was assembled, and was
 * the single largest contributor to a launch payload that has a hard
 * ceiling — see `assemblePersonaPrompt`.
 */
export type ReviewDiffResult = {
  /** `git diff --stat <baseRef>...HEAD` — committed changes only. */
  stat: string;
  /** `git diff --stat HEAD` — uncommitted working tree changes. */
  uncommittedStat: string;
  /** Untracked file paths (from `git ls-files --others`). */
  untrackedFiles: string[];
  baseRef: string;
  /** Whether anything at all changed — drives the "nothing to review" copy. */
  hasChanges: boolean;
};

export async function buildPersonaReviewDiff(
  cwd: string,
  baseRef: string,
  runCommand: RunCommandFn
): Promise<ReviewDiffResult> {
  try {
    const [untrackedResult, statResult, uncommittedStatResult] =
      await Promise.all([
        runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
          cwd,
        }),
        runCommand("git", ["diff", "--stat", `${baseRef}...HEAD`], { cwd }),
        runCommand("git", ["diff", "--stat", "HEAD"], { cwd }),
      ]);

    const untrackedFiles = untrackedResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const stat = trimTrailingWhitespace(statResult.stdout);
    const uncommittedStat = trimTrailingWhitespace(
      uncommittedStatResult.stdout
    );

    return {
      stat,
      uncommittedStat,
      untrackedFiles,
      baseRef,
      hasChanges: Boolean(stat || uncommittedStat || untrackedFiles.length),
    };
  } catch {
    return {
      stat: "",
      uncommittedStat: "",
      untrackedFiles: [],
      baseRef,
      hasChanges: false,
    };
  }
}
