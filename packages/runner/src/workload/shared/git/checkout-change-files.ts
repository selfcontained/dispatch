import type { CommandRunner } from "../lib/run-command.js";

export async function collectCheckoutChanges(
  cwd: string,
  baseRef: string,
  run: CommandRunner,
  head: string = "HEAD"
) {
  // --no-renames represents a rename as deletion + addition, so both owners
  // are selected. NUL delimiters preserve whitespace and unusual filenames.
  const [committed, staged, unstaged, untracked] = await Promise.all([
    run(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${baseRef}...${head}`,
        "--",
      ],
      { cwd, trimOutput: false }
    ),
    // Index and working-tree edits can cancel in diff HEAD. Collect both.
    run(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "-z", head, "--"],
      { cwd, trimOutput: false }
    ),
    run("git", ["diff", "--name-only", "--no-renames", "-z", "--"], {
      cwd,
      trimOutput: false,
    }),
    run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      trimOutput: false,
    }),
  ]);
  const paths = (stdout: string) => stdout.split("\0").filter(Boolean);
  return {
    committed: paths(committed.stdout),
    staged: paths(staged.stdout),
    unstaged: paths(unstaged.stdout),
    untracked: paths(untracked.stdout),
  };
}

export function checkoutChangedPaths(
  changes: Awaited<ReturnType<typeof collectCheckoutChanges>>
): string[] {
  return [...new Set(Object.values(changes).flat())].sort();
}

export async function collectCheckoutFiles(
  cwd: string,
  baseRef: string,
  run: CommandRunner
): Promise<string[]> {
  return checkoutChangedPaths(await collectCheckoutChanges(cwd, baseRef, run));
}
