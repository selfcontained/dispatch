/*
 * The few filesystem calls the `linux-privsep` platform makes as the
 * supervisor (root on a real host). They are a port so the ownership and
 * mode rules can be proved with a fake on a machine where the tests cannot
 * be root; the real one is Node's, never following a link where it matters.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lchown,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";

/** What the platform reads from an `lstat`. */
export type Entry = {
  uid: number;
  gid: number;
  /** Permission bits only (`mode & 0o7777`). */
  mode: number;
  kind: "directory" | "link" | "file" | "other";
};

export interface PrivsepFs {
  /** The entry itself (a link is reported as a link), or null when missing. */
  lstat(path: string): Promise<Entry | null>;
  /** Make one directory (not its parents); `EEXIST` is an error. */
  mkdir(path: string, mode: number): Promise<void>;
  /** Change the owner of the entry itself, never a link's target. */
  lchown(path: string, uid: number, gid: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
  /** Remove an empty directory. */
  rmdir(path: string): Promise<void>;
  /** Remove a file or a whole tree the supervisor owns; missing is fine. */
  rm(path: string): Promise<void>;
  /** A file's text, or null when it is missing. */
  read(path: string): Promise<string | null>;
  /** Replace `file` in `dir` durably: 0600, flushed, renamed, directory synced. */
  writePrivate(dir: string, file: string, contents: string): Promise<void>;
}

const missing = (error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
};

async function syncDirectory(dir: string) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const nodeFs: PrivsepFs = {
  async lstat(path) {
    const entry = await lstat(path).catch(missing);
    if (!entry) return null;
    return {
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode & 0o7777,
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "link"
          : entry.isFile()
            ? "file"
            : "other",
    };
  },
  mkdir: (path, mode) => mkdir(path, { mode }).then(() => {}),
  lchown,
  chmod,
  realpath: (path) => realpath(path),
  rmdir,
  rm: (path) => rm(path, { recursive: true, force: true }),
  read: (path) => readFile(path, "utf8").catch(missing),
  async writePrivate(dir, file, contents) {
    const temp = join(dir, `.pending-${randomUUID()}`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(dir, file));
      await syncDirectory(dir);
    } finally {
      await rm(temp, { force: true });
    }
  },
};
