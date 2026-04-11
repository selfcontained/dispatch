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

export async function buildPersonaReviewDiff(
  cwd: string,
  runCommand: RunCommandFn
): Promise<string> {
  let baseBranch = "main";
  let baseBranchDetected = true;

  try {
    const headRef = await runCommand(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd }
    );
    baseBranch = headRef.stdout.trim().replace(/^origin\//, "");
  } catch {
    baseBranchDetected = false;
  }

  try {
    const [committedResult, uncommittedResult, untrackedResult] = await Promise.all([
      runCommand("git", ["diff", `${baseBranch}...HEAD`], { cwd }),
      runCommand("git", ["diff", "HEAD"], { cwd }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
    ]);

    const committedDiff = trimTrailingWhitespace(committedResult.stdout);
    const uncommittedDiff = trimTrailingWhitespace(uncommittedResult.stdout);
    const untrackedFiles = untrackedResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const sections: string[] = [];

    if (!baseBranchDetected) {
      sections.push(
        `(Note: base branch detection failed; committed diff was generated against "${baseBranch}". If this looks wrong, the repo may use a different default branch.)`
      );
    }

    if (committedDiff) {
      sections.push(`### Committed changes since ${baseBranch}\n${committedDiff}`);
    }

    if (uncommittedDiff) {
      sections.push(`### Uncommitted working tree changes\n${uncommittedDiff}`);
    }

    if (untrackedFiles.length > 0) {
      sections.push(`### Untracked files\n${untrackedFiles.map((file) => `- ${file}`).join("\n")}`);
    }

    if (sections.length === 0) {
      return "(no committed or uncommitted changes detected)";
    }

    return sections.join("\n\n");
  } catch {
    return "(unable to generate diff)";
  }
}
