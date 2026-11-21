import { runCommand, type CommandRunner } from "../lib/run-command.js";
import { resolveCurrentBranch } from "./git-context.js";

/**
 * The repo's default branch: origin/HEAD when the clone recorded it,
 * otherwise the first of main/master that exists. Null when none do.
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
    ["-C", dir, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
    opts
  ).catch(() => null);
  const fromOrigin = originHead?.exitCode === 0 ? originHead.stdout.trim() : "";
  if (fromOrigin.startsWith("refs/remotes/origin/")) {
    return fromOrigin.slice("refs/remotes/origin/".length);
  }
  for (const branch of ["main", "master"]) {
    for (const ref of [
      `refs/remotes/origin/${branch}`,
      `refs/heads/${branch}`,
    ]) {
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

export async function localDefaultBranch(cwd: string): Promise<string> {
  return (
    (await detectDefaultBranch(cwd)) ??
    (await resolveCurrentBranch(cwd).catch(() => null)) ??
    "main"
  );
}
