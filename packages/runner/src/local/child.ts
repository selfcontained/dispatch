import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_WIRE_VERSION } from "@dispatch/runner-protocol";
import {
  runnerIdFromWire,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  LAUNCHER_PROTOCOL,
  launcherCommand,
  launcherExit,
  launcherStart,
  type LauncherFence,
  type LauncherImported,
  type LauncherReady,
  type LauncherRefusal,
  type LauncherStart,
} from "@dispatch/runner-client/launcher";
import { jsonLines } from "@dispatch/runner-client/transport/local-socket";
import { BindingStore } from "./bindings.js";
import { WriteFence } from "./fence.js";
import { healthSampler } from "./health.js";
import {
  inspectProcess,
  readHolder,
  tryLock,
  writeHolder,
  type HeldLock,
} from "./lock.js";
import { serveSocket, type Handlers } from "./socket-server.js";
import { checkoutHandlers } from "../core/checkout.js";
import type { Platform } from "../platform/types.js";

export type Build = { version: string; revision?: string };

/** How long a replacement waits for a leftover runner to leave by itself. */
const LEFTOVER_WAIT_MS = 3_000;
/** How long after SIGTERM before SIGKILL. */
const LEFTOVER_KILL_MS = 2_000;
/** How long the lock may be held by a process that cannot be identified. */
const UNKNOWN_HOLDER_MS = 8_000;
const START_TIMEOUT_MS = 10_000;
/** macOS limits a socket path to 104 bytes, including the terminator. */
const SOCKET_PATH_MAX = 103;

/** An `import` with its sequence number, bindings not yet checked. */
function importMessage(
  message: unknown
): { seq: number; bindings: unknown[] } | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, seq, bindings } = message as Record<string, unknown>;
  return type === "import" &&
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    Array.isArray(bindings)
    ? { seq, bindings }
    : null;
}

/** Fence admission name for the launcher's `import`; never a socket operation. */
const IMPORT_ADMISSION = "launcher.import";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string) {
  writeSync(2, `local-runner: ${line}\n`);
}

function refuse(reason: LauncherRefusal, message: string): never {
  log(message);
  process.exit(launcherExit[reason]);
}

const sameBuild = (a: Build, b: Build) =>
  a.version === b.version && (a.revision ?? null) === (b.revision ?? null);
const describeBuild = (b: Build) =>
  b.revision ? `${b.version} (${b.revision})` : b.version;

/** A private 0700 directory for sockets and holder records, outside state. */
function runtimeDirectory(): string {
  const uid = process.getuid?.() ?? 0;
  const dir = join(tmpdir(), `runner-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    refuse("invalid", `Runtime directory ${dir} is not private to this user`);
  return dir;
}

/**
 * The `local-runner` mode: read `start` from stdin, check the exact build,
 * take the state lock, serve the socket and answer `ready`. EOF on stdin (the
 * lifeline) or SIGTERM ends it. It never stops detached hosts.
 */
export async function runLocalRunner(
  own: Build,
  options: {
    /** Operations served beside describe and health, as families move in. */
    handlers?: (start: LauncherStart, fence: WriteFence) => Handlers;
    /** The machine's platform; without one, no checkout family is served. */
    platform?: Platform;
  } = {}
): Promise<void> {
  let start: LauncherStart | undefined;
  let stop: () => void = () => process.exit(0);

  // The lifeline: the parent's end closed, whether it exited or was killed.
  process.stdin.on("end", () => stop());
  process.stdin.on("close", () => stop());
  process.stdin.on("error", () => stop());
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => stop());

  // Created from `start`, before the socket serves anything.
  let fence: WriteFence | undefined;
  let store: BindingStore | undefined;
  let markServing!: () => void;
  const serving = new Promise<void>((resolve) => (markServing = resolve));
  // Fence commands apply in order: a `thaw` never overtakes a `freeze`
  // still waiting for earlier writes to finish.
  let fencing = Promise.resolve();
  const answerFence = (seq: number) => {
    const answer: LauncherFence = { type: "fence", seq, frozen: fence!.frozen };
    process.stdout.write(JSON.stringify(answer) + "\n");
  };
  const importBindings = async ({
    seq,
    bindings,
  }: {
    seq: number;
    bindings: unknown[];
  }) => {
    // Nothing is written before the state lock is held.
    await serving;
    const answer: LauncherImported = {
      type: "imported",
      seq,
      added: 0,
      kept: 0,
      invalid: 0,
      frozen: true,
    };
    const release = fence!.enter(IMPORT_ADMISSION);
    if (release) {
      answer.frozen = false;
      try {
        Object.assign(answer, await store!.import(bindings));
      } catch (error) {
        answer.error = error instanceof Error ? error.message : String(error);
        log(`Binding import failed: ${answer.error}`);
      } finally {
        release();
      }
    }
    process.stdout.write(JSON.stringify(answer) + "\n");
  };
  const started = new Promise<LauncherStart>((resolve) => {
    jsonLines(process.stdin, (message) => {
      if (!start) {
        if (!launcherStart.check(message))
          refuse("invalid", "The first launcher message must be start");
        start = message;
        fence = new WriteFence(message.frozen === true);
        store = new BindingStore(message.roots.state);
        return resolve(message);
      }
      // `import`, in the same order as the fence. It is answered even when
      // some bindings are malformed: the store counts and skips those. A
      // frozen runner writes no binding and says so; the parent sends it
      // again after `thaw`.
      const importing = importMessage(message);
      if (importing) {
        fencing = fencing.then(() => importBindings(importing));
        return;
      }
      if (!launcherCommand.check(message))
        return log("Ignored an unknown launcher message");
      if (message.type === "freeze" || message.type === "thaw") {
        const { seq } = message;
        fencing = fencing.then(async () => {
          if (message.type === "freeze") await fence!.freeze();
          else fence!.thaw();
          answerFence(seq);
        });
      }
    });
  });
  const timer = setTimeout(
    () => refuse("invalid", "No start message arrived"),
    START_TIMEOUT_MS
  );
  const message = await started;
  clearTimeout(timer);

  if (message.protocol !== LAUNCHER_PROTOCOL || !sameBuild(message.build, own))
    refuse(
      "mismatch",
      `Build mismatch: the app is ${describeBuild(message.build)} (launcher ${message.protocol}), this runner is ${describeBuild(own)} (launcher ${LAUNCHER_PROTOCOL})`
    );

  mkdirSync(message.roots.state, { recursive: true });
  const root = realpathSync(message.roots.state);
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const runtime = runtimeDirectory();
  const socketPath = join(runtime, `${key}.sock`);
  const holderPath = join(runtime, `${key}.holder`);
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX)
    refuse("invalid", `Socket path ${socketPath} is too long`);

  const lock = await acquire(root, key, holderPath);
  writeHolder(holderPath, { pid: process.pid, parent: process.ppid, root });

  const health = healthSampler(own);
  const description: RunnerDescription = {
    runnerId: runnerIdFromWire(message.config.runnerId),
    displayName: message.config.displayName,
    build: own,
    protocol: RUNNER_WIRE_VERSION,
    engines: message.config.engines,
    capabilities: {},
  };
  const extra = options.handlers?.(message, fence!);
  const checkout = options.platform
    ? checkoutHandlers(store!, options.platform)
    : {};
  const socket = await serveSocket(
    socketPath,
    message.nonce,
    {
      calls: {
        ...checkout,
        ...extra?.calls,
        "runner.describe": () => description,
        "runner.health": () => health(),
      },
      opens: extra?.opens,
    },
    fence
  );

  stop = () => {
    socket.close();
    if (readHolder(holderPath)?.pid === process.pid)
      rmSync(holderPath, { force: true });
    lock.release();
    process.exit(0);
  };

  const ready: LauncherReady = {
    type: "ready",
    build: own,
    protocol: LAUNCHER_PROTOCOL,
    nonce: message.nonce,
    socket: socketPath,
    frozen: fence!.frozen,
  };
  process.stdout.write(JSON.stringify(ready) + "\n");
  markServing();
}

/**
 * Take the state lock. A holder whose parent is alive and is not ours belongs
 * to another app: refuse. A holder whose parent is gone, or which an earlier
 * start of our own parent left, is a leftover: wait for its lifeline, then
 * signal it, but only once its command line, root and recorded identity
 * match.
 */
async function acquire(
  root: string,
  key: string,
  holderPath: string
): Promise<HeldLock> {
  const began = Date.now();
  let killAt: number | undefined;
  let killed = false;
  for (;;) {
    const lock = await tryLock(root, key);
    if (lock) return lock;
    const holder = readHolder(holderPath);
    const info =
      holder && holder.root === root ? inspectProcess(holder.pid) : null;
    if (holder && info) {
      const theirParentAlive = info.parent === holder.parent;
      if (theirParentAlive && holder.parent !== process.ppid)
        refuse(
          "locked",
          `State root ${root} is in use by another app's runner (pid ${holder.pid}, app pid ${holder.parent})`
        );
      if (!/(^|\s)local-runner(\s|$)/.test(info.command))
        refuse(
          "locked",
          `State root ${root} is locked by pid ${holder.pid}, which is not a runner`
        );
      const now = Date.now();
      if (killAt === undefined && now - began >= LEFTOVER_WAIT_MS) {
        log(`Stopping leftover runner ${holder.pid} for ${root}`);
        signal(holder.pid, "SIGTERM");
        signal(holder.pid, "SIGCONT"); // A stopped leftover handles it too.
        killAt = now + LEFTOVER_KILL_MS;
      } else if (killAt !== undefined && !killed && now >= killAt) {
        signal(holder.pid, "SIGKILL");
        killed = true;
      }
    } else if (Date.now() - began >= UNKNOWN_HOLDER_MS) {
      refuse("locked", `State root ${root} is locked by an unknown process`);
    }
    await sleep(50);
  }
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}
