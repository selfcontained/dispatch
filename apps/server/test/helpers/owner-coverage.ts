import { execFileSync } from "node:child_process";
import { childProcessEnv } from "../../src/shared/process/child-environment.js";
import { checkOwnerCoverage as checkWithGit } from "../../src/personas/coverage.js";

/** Native Git wiring for coverage fixtures; the production algorithm is pure. */
export function checkOwnerCoverage(
  input: Omit<Parameters<typeof checkWithGit>[0], "git"> & {
    git?: Parameters<typeof checkWithGit>[0]["git"];
  }
) {
  return checkWithGit({
    ...input,
    git:
      input.git ??
      ((args) =>
        execFileSync("git", args, {
          env: childProcessEnv(),
          cwd: input.cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        })),
  });
}
