import { realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";

export async function resolveProjectRoot(input: string): Promise<string> {
  const cwd = await realpath(resolveTilde(input));
  if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", ["-C", cwd, ...args], {
        env: { ...process.env, LC_ALL: "C" },
      })
    ).stdout.trim();
  // A plain folder (no Git) is its own project root. Any other Git failure
  // (dubious ownership, broken install) must not bypass canonicalization.
  const common = await git(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ).catch((error: { stderr?: string }) => {
    if (/not a git repository/i.test(error.stderr ?? "")) return null;
    throw error;
  });
  if (common === null) return cwd;
  const gitDir = await git("rev-parse", "--absolute-git-dir");
  // Normal discovery handles nested paths and separate Git metadata.
  // A linked worktree instead uses the primary checkout from Git's registry.
  const root =
    common === gitDir
      ? await git("rev-parse", "--show-toplevel")
      : (await git("worktree", "list", "--porcelain", "-z"))
          .split("\0")[0]!
          .slice("worktree ".length);
  return realpath(root);
}
