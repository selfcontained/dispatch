import { execFile } from "node:child_process";

/** One bounded Git request per opened folder, never one process per entry.
 * Git handles nested/global ignore rules, negations and tracked exceptions. */
export function ignoredWorkspacePaths(
  root: string,
  paths: string[]
): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin", "-z"],
      {
        cwd: root,
        timeout: 2000,
        maxBuffer: 1_048_576,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 1) {
          // Plain folders remain browsable without requiring a Git repository.
          if (error.code === 128 && stderr.includes("not a git repository"))
            resolve(new Set());
          else reject(error);
          return;
        }
        resolve(new Set(stdout.split("\0").filter(Boolean)));
      }
    );
    child.stdin?.on("error", () => {}); // Process exit is handled above.
    child.stdin?.end(paths.join("\0") + "\0");
  });
}
