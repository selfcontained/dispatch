import { runCommand, type CommandRunner } from "../lib/run-command.js";

/**
 * The repo's default branch, as main reads it: origin/HEAD when the clone
 * recorded it, otherwise the first of main/master that Git resolves by its
 * short name (`origin/<name>`, then `<name>`, so a tag of that name counts,
 * as on main). Null when none does.
 */
export async function detectDefaultBranch(
  dir: string,
  run: CommandRunner = runCommand
): Promise<string | null> {
  const opts = {
    allowedExitCodes: [0, 1, 128],
    timeoutMs: 5_000,
  };
  const originHead = await run(
    "git",
    ["-C", dir, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    opts
  ).catch(() => null);
  const fromOrigin = originHead?.exitCode === 0 ? originHead.stdout.trim() : "";
  if (fromOrigin.startsWith("origin/")) {
    return fromOrigin.slice("origin/".length);
  }
  for (const branch of ["main", "master"]) {
    for (const ref of [`origin/${branch}`, branch]) {
      const found = await run(
        "git",
        ["-C", dir, "rev-parse", "--verify", "--quiet", ref],
        opts
      ).catch(() => null);
      if (found?.exitCode === 0 && found.stdout.trim()) return branch;
    }
  }
  return null;
}
