import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
// These flags are provided by the operating systems but aren't exposed by Node.
export const DARWIN_NOFOLLOW_ANY = 0x20000000;
const LINUX_OPEN_PATH = 0x200000;

export async function openRegularFile(
  root: string,
  segments: string[]
): Promise<FileHandle> {
  const target = path.join(root, ...segments);
  if (process.platform === "darwin") {
    if (!(await lstat(target)).isFile())
      throw new Error("Expected a regular worktree file");
    return open(
      target,
      constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_NOFOLLOW_ANY
    );
  }
  if (process.platform !== "linux") {
    throw new Error("Checkout file inspection requires macOS or Linux");
  }

  const directory = await openLinuxDirectory(path.dirname(target));
  try {
    const entry = await open(
      `/proc/self/fd/${directory.fd}/${segments.at(-1)}`,
      LINUX_OPEN_PATH | constants.O_NOFOLLOW
    );
    try {
      if (!(await entry.stat()).isFile())
        throw new Error("Expected a regular worktree file");
      return await open(`/proc/self/fd/${entry.fd}`, constants.O_RDONLY);
    } finally {
      await entry.close();
    }
  } finally {
    await directory.close();
  }
}

// Pin every directory component so a symlink replacement cannot redirect
// traversal. The procfs path acts as openat for Node's pathname APIs.
export async function openLinuxDirectory(target: string): Promise<FileHandle> {
  let directory = await open("/", LINUX_OPEN_PATH | constants.O_DIRECTORY);
  try {
    for (const segment of target.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        LINUX_OPEN_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}
