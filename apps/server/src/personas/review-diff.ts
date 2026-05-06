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

export type ReviewDiffResult = {
  diff: string;
  /** `git diff --stat <baseRef>...HEAD` — committed changes only. */
  stat: string;
  /** `git diff --stat HEAD` — uncommitted working tree changes. */
  uncommittedStat: string;
  /** Untracked file paths (from `git ls-files --others`). */
  untrackedFiles: string[];
  baseRef: string;
  diffByteSize: number;
};

export async function buildPersonaReviewDiff(
  cwd: string,
  baseRef: string,
  runCommand: RunCommandFn
): Promise<ReviewDiffResult> {
  const baseName = baseRef.replace(/^origin\//, "");

  try {
    const [
      committedResult,
      uncommittedResult,
      untrackedResult,
      statResult,
      uncommittedStatResult,
    ] = await Promise.all([
      runCommand("git", ["diff", `${baseRef}...HEAD`], { cwd }),
      runCommand("git", ["diff", "HEAD"], { cwd }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd,
      }),
      runCommand("git", ["diff", "--stat", `${baseRef}...HEAD`], { cwd }),
      runCommand("git", ["diff", "--stat", "HEAD"], { cwd }),
    ]);

    const committedDiff = trimTrailingWhitespace(committedResult.stdout);
    const uncommittedDiff = trimTrailingWhitespace(uncommittedResult.stdout);
    const untrackedFiles = untrackedResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const stat = trimTrailingWhitespace(statResult.stdout);
    const uncommittedStat = trimTrailingWhitespace(
      uncommittedStatResult.stdout
    );

    const sections: string[] = [];

    if (committedDiff) {
      sections.push(
        `### Committed changes since ${baseName}\n${committedDiff}`
      );
    }

    if (uncommittedDiff) {
      sections.push(`### Uncommitted working tree changes\n${uncommittedDiff}`);
    }

    if (untrackedFiles.length > 0) {
      sections.push(
        `### Untracked files\n${untrackedFiles.map((file) => `- ${file}`).join("\n")}`
      );
    }

    if (sections.length === 0) {
      return {
        diff: "(no committed or uncommitted changes detected)",
        stat: "",
        uncommittedStat: "",
        untrackedFiles: [],
        baseRef,
        diffByteSize: 0,
      };
    }

    const diff = sections.join("\n\n");
    return {
      diff,
      stat,
      uncommittedStat,
      untrackedFiles,
      baseRef,
      diffByteSize: Buffer.byteLength(diff, "utf-8"),
    };
  } catch {
    return {
      diff: "(unable to generate diff)",
      stat: "",
      uncommittedStat: "",
      untrackedFiles: [],
      baseRef,
      diffByteSize: 0,
    };
  }
}
