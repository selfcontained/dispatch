import type { CommandRunner } from "../lib/run-command.js";

export async function collectOwnerReviewFiles(
  cwd: string,
  baseRef: string,
  run: CommandRunner,
  head: string = "HEAD"
): Promise<string[]> {
  // --no-renames represents a rename as deletion + addition, so both owners
  // are selected. NUL delimiters preserve whitespace and unusual filenames.
  const results = await Promise.all([
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
  return [
    ...new Set(
      results.flatMap((result) => result.stdout.split("\0").filter(Boolean))
    ),
  ].sort();
}
