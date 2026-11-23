/*
 * The `posix-user` session ports: hosts run as the runner's own account, in
 * one directory per session under the agent state root, with the layout,
 * records and process identity every earlier build of the app uses. An app
 * rolled back to an older build finds the same files and drives the same
 * hosts, and this runner adopts hosts those builds started by reading what
 * they wrote:
 *
 *   <root>/<key>/ownership  the bare ownership marker, written before spawn
 *   <root>/<key>/host.pid   the host's pid, written by the host
 *   <root>/<key>/host.sock  the host's socket
 *   <root>/<key>/host.log   the host's output
 *
 * A host is identified as the older builds identify it: the pid its file
 * names is alive and its command line ends with `--state <dir>`. Nothing
 * here connects to a host's socket to find out: a second connection evicts
 * the first.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type {
  HostRecord,
  PrivateStatePort,
  SessionLayout,
  SessionProcessPort,
} from "../../core/sessions.js";

/** Host file names, the same in every build that ran local hosts. */
export const POSIX_HOST_FILES = {
  ownership: "ownership",
  pid: "host.pid",
  socket: "host.sock",
  log: "host.log",
  /** The host's launch file, written before it starts. */
  launch: "launch.json",
  /** This runner's launch record; older builds never read it. */
  launchRecord: "runner-launch.json",
} as const;

/** How long a stop waits for the host to exit by itself, then after SIGTERM. */
export const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const PS_TIMEOUT_MS = 2_000;

/**
 * What the embedding app supplies: its host's entry point and how it marks
 * and cleans up the processes a host starts. Injected, so the runner names
 * no app concept.
 */
export type PosixHostEntry = {
  /** The host's argv; the runner appends `--state <dir>`. */
  command(): string[];
  /** How a command starts in the user's environment (a login shell). */
  wrap(command: string[]): { bin: string; args: string[] };
  /** The environment a host starts with, before its marker. */
  env(): NodeJS.ProcessEnv;
  ownership: {
    /** A fresh marker and the environment that carries it. */
    create(env: NodeJS.ProcessEnv): { marker: string; env: NodeJS.ProcessEnv };
    /** Remove every process that still carries the marker. */
    cleanup(marker: string): void;
  };
};

/** A recorded host: its ownership marker and its directory. */
export type PosixHost = HostRecord & { dir: string };

/** Whether `key` names a directory directly under the root. */
export function validKey(key: string) {
  return !!key && key !== "." && key !== ".." && basename(key) === key;
}

function checkedKey(key: string) {
  if (!validKey(key))
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid session state directory",
    });
  return key;
}

export function posixUserLayout(root: string): SessionLayout {
  const dir = (key: string) => join(root, checkedKey(key));
  const file = (key: string, name: string) => join(dir(key), name);
  return {
    hostDir: dir,
    socket: (key) => file(key, POSIX_HOST_FILES.socket),
    sockets: (key) => [file(key, POSIX_HOST_FILES.socket)],
    identityFile: (key) => file(key, POSIX_HOST_FILES.ownership),
    // The bare marker is the record itself; there is no older format.
    markerFile: (key) => file(key, POSIX_HOST_FILES.ownership),
    launchFile: (key) => file(key, POSIX_HOST_FILES.launchRecord),
    logFile: (key) => file(key, POSIX_HOST_FILES.log),
    async trackedKeys() {
      const keys: string[] = [];
      for (const entry of await entries(root)) {
        if (!entry.isDirectory() || !validKey(entry.name)) continue;
        const has = (name: string) =>
          lstat(join(root, entry.name, name)).then(
            () => true,
            () => false
          );
        if (
          (await has(POSIX_HOST_FILES.ownership)) ||
          (await has(POSIX_HOST_FILES.pid))
        )
          keys.push(entry.name);
      }
      return keys.sort();
    },
  };
}

async function entries(root: string) {
  return readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
}

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null;
  throw error;
};

/** Private state as plain owner-only files; records stay readable by older builds. */
export const posixUserState: PrivateStatePort = {
  read: (file) => readFile(file, "utf8").catch(missing),
  async write(file, contents) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  },
  remove: (file) =>
    unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  exists: (file) =>
    lstat(file).then(
      () => true,
      () => false
    ),
  async openPrivate(file) {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return null;
      throw error;
    });
    if (!handle) return null;
    return {
      async trusted() {
        const stat = await handle.stat();
        return (
          stat.isFile() &&
          stat.uid === (process.getuid?.() ?? stat.uid) &&
          stat.size <= 4096
        );
      },
      read: () => handle.readFile("utf8"),
      close: () => handle.close(),
    };
  },
};

const processArgs = promisify(execFile);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** The pid a host recorded, unverified; null when none or malformed. */
export function recordedPid(dir: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(dir, POSIX_HOST_FILES.pid), "utf8");
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

const hostCommandOf = (args: string, dir: string) =>
  args.trim().endsWith(`agent-host --state ${dir}`);

/** Whether `pid` is the host for `dir`, read now. A failed `ps` is no. */
export async function isHostPid(pid: number, dir: string) {
  if (!pidAlive(pid)) return false;
  try {
    const { stdout } = await processArgs(
      "/bin/ps",
      ["-p", String(pid), "-o", "args="],
      { env: { PATH: process.env.PATH }, timeout: PS_TIMEOUT_MS }
    );
    return hostCommandOf(stdout, dir);
  } catch {
    return false;
  }
}

function isHostPidSync(pid: number, dir: string) {
  if (!pidAlive(pid)) return false;
  try {
    const stdout = execFileSync("/bin/ps", ["-p", String(pid), "-o", "args="], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return hostCommandOf(stdout, dir);
  } catch {
    return false;
  }
}

/**
 * A host directory's state, as older builds read it: `gone` with no pid
 * record or a pid that is not running, `stale` when the record is malformed
 * or names another process, `live` when it names this directory's host.
 */
export async function inspectHostDir(
  dir: string
): Promise<{ state: "live" | "gone" | "stale"; pid: number | null }> {
  let text: string | null;
  try {
    text = await readFile(join(dir, POSIX_HOST_FILES.pid), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "gone", pid: null };
    throw error;
  }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { state: "stale", pid: null };
  if (!pidAlive(pid)) return { state: "gone", pid: null };
  if (await isHostPid(pid, dir)) return { state: "live", pid };
  return { state: "stale", pid: null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function posixUserProcesses(
  layout: SessionLayout,
  entry: PosixHostEntry
): SessionProcessPort<PosixHost> {
  const dirOfSocket = (socket: string) => dirname(socket);
  const live = (dir: string) => {
    const pid = recordedPid(dir);
    return pid !== null && isHostPidSync(pid, dir);
  };
  return {
    alive: (identity) => live(identity.dir),
    async spawn(command, cwd, env, log, record, onExit) {
      // The marker is the identity, known before the process exists: it is
      // recorded first, so a runner killed right after spawning still finds
      // the host by the files any build reads.
      const [first, ...rest] = command;
      if (!first) throw new Error("Runner host executable is missing");
      const owned = entry.ownership.create(env);
      const state = rest.at(-1)!;
      const identity: PosixHost = { marker: owned.marker, dir: state };
      await record(identity);
      // A stale socket from a dead host would make connect() spin on
      // ECONNREFUSED until the new host replaces it; clear it first.
      await unlink(layout.socket(basename(state))).catch(() => {});
      const child = spawn(first, rest, {
        cwd,
        env: owned.env,
        detached: true,
        stdio: ["ignore", log, log],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      // The shell execs the host, so this is the host's own exit.
      child.once("exit", () => onExit(identity));
      child.unref();
    },
    async stop(identity, force) {
      const { dir } = identity;
      const pid = recordedPid(dir);
      if (pid === null || !(await isHostPid(pid, dir))) return;
      const deadline = Date.now() + (force ? 0 : STOP_GRACE_MS);
      while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
      if (await isHostPid(pid, dir)) {
        signalGroup(pid, "SIGTERM");
        const killAt = Date.now() + KILL_GRACE_MS;
        while (Date.now() < killAt && pidAlive(pid)) await sleep(200);
        if (await isHostPid(pid, dir)) signalGroup(pid, "SIGKILL");
      }
    },
    async cleanup(identity) {
      entry.ownership.cleanup(identity.marker);
      // What a stopped host leaves behind, as older builds remove it.
      for (const name of [POSIX_HOST_FILES.socket, POSIX_HOST_FILES.pid])
        try {
          unlinkSync(join(identity.dir, name));
        } catch {
          // Already gone.
        }
    },
    async cleanupLegacy(marker) {
      entry.ownership.cleanup(marker);
    },
    socketMatchesHost: (socket, identity) =>
      dirOfSocket(socket) === identity.dir && live(identity.dir),
    // A socket is in use when its directory's recorded host is running;
    // probing it would evict the host's client.
    socketInUse: (socket) => live(dirOfSocket(socket)),
    // Hosts share the runner's account: the path is what the client dials.
    pinSocket: (socket) => ({ address: socket, release() {} }),
    parseIdentity(raw, key) {
      const marker = raw.trim();
      if (!marker || /\s/.test(marker))
        throw new Error("Invalid host ownership record");
      return { marker, dir: layout.hostDir(key) };
    },
    // Older builds read the record as the bare marker.
    formatIdentity: (identity) => identity.marker,
  };
}

/** The host's command for `dir`, through the entry's wrapper. */
export function hostCommandFor(entry: PosixHostEntry, dir: string) {
  const { bin, args } = entry.wrap([...entry.command(), "--state", dir]);
  return [bin, ...args];
}
