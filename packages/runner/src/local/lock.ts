import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";

/*
 * One runner per state root, held by the kernel and released when the
 * process dies, however it dies.
 *
 * - macOS: `open(root, O_RDONLY | O_EXLOCK | O_NONBLOCK)` takes a flock on the
 *   state root directory itself, so no lock file sits in backed-up state or
 *   in a temp directory a cleaner could remove. Proved on macOS with node and
 *   bun, including release on SIGKILL.
 * - Linux: an abstract-namespace socket named after the root. Not proved here.
 *
 * libuv opens with O_CLOEXEC, so processes the runner starts never inherit it.
 */

/** macOS `O_EXLOCK`; Node does not export it. */
const O_EXLOCK = 0x20;

export type Holder = {
  /** The runner holding the lock. */
  pid: number;
  /** Its parent when it took the lock. */
  parent: number;
  /** The canonical state root. */
  root: string;
};

export type HeldLock = { release(): void };

/** Take the lock without waiting; null when another process holds it. */
export async function tryLock(
  root: string,
  key: string
): Promise<HeldLock | null> {
  if (process.platform === "darwin") {
    try {
      const fd = openSync(
        root,
        constants.O_RDONLY | constants.O_NONBLOCK | O_EXLOCK
      );
      return { release: () => closeSync(fd) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") return null;
      throw error;
    }
  }
  if (process.platform === "linux") {
    const server: Server = createServer();
    return new Promise((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(null) : reject(error)
      );
      server.listen(`\0runner-lock-${key}`, () => {
        server.unref();
        resolve({ release: () => server.close() });
      });
    });
  }
  throw new Error(`No state lock on ${process.platform}`);
}

export function writeHolder(path: string, holder: Holder) {
  writeFileSync(path, JSON.stringify(holder) + "\n", { mode: 0o600 });
}

export function readHolder(path: string): Holder | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return Number.isSafeInteger(value.pid) &&
      Number.isSafeInteger(value.parent) &&
      typeof value.root === "string"
      ? (value as Holder)
      : null;
  } catch {
    return null;
  }
}

/** A live process's parent and command line, or null when it is gone. */
export function inspectProcess(
  pid: number
): { parent: number; command: string } | null {
  try {
    const output = execFileSync(
      "ps",
      ["-ww", "-o", "ppid=,command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const match = output.match(/^\s*(\d+)\s+(.*)$/m);
    return match ? { parent: Number(match[1]), command: match[2]! } : null;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}
