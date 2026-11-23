/*
 * The local runner's session family over the session core and the
 * `posix-user` ports. It tracks the hosts under the agent state root from
 * the records every build writes, so hosts an older build or the app
 * started are adopted as they are found: nothing is probed, signalled or
 * rewritten to adopt them.
 *
 * This runner is the only one that starts and stops local hosts: launch,
 * stop and discard run here under the session lock, and the core's sweep
 * cleans the descendants of hosts that exited while no runner watched them,
 * never while a host carrying the marker still runs (a starting host has
 * not written its pid yet). An app rolled back to an older build finds the
 * same records and drives the same hosts.
 */
import { mkdir, open, rm, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import {
  RunnerCallError,
  displayPath,
  pathFromWire,
  sessionFromWire,
  sessionToWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import {
  decodeSessionFrame,
  frameDecoder,
  mapIncomingFrames,
} from "@dispatch/runner-client/v1/host";
import type { Handlers } from "./socket-server.js";
import {
  createSessionCore,
  type SessionCoreFactory,
} from "../core/sessions.js";
import {
  POSIX_HOST_FILES,
  STOP_GRACE_MS,
  hostCommandFor,
  inspectHostDir,
  liveHost,
  markedHostRunning,
  posixUserLayout,
  posixUserProcesses,
  posixUserState,
  validKey,
  type PosixHostEntry,
} from "../platform/posix-user/sessions.js";

const CONNECT_TIMEOUT_MS = 5_000;
/** The most log a `session.logs` answer reads from the end of the file. */
const LOG_WINDOW_BYTES = 256 * 1024;

/** How long a launch waits for its host to record itself before answering. */
const START_WAIT_MS = 30_000;

export type LocalSessionOptions = {
  /** The agent state root, exactly as the app names it in host commands. */
  root: string;
  entry: PosixHostEntry;
  /** The host's argv from the launcher's start; else the entry's own. */
  command?: string[];
  createSessions?: SessionCoreFactory;
  /** The update fence: no sweep and no host writes on open channels while frozen. */
  fence?: { readonly frozen: boolean };
  /** How often exited hosts are swept; null never (tests). */
  sweepMs?: number | null;
  /** The directory a session is bound to, for a launch that names none. */
  boundDirectory?: (key: string) => Promise<string | null>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Frames a caller may send a host on an open channel while the runner is
 * frozen: reads, quiesce, and the stops an update makes of idle hosts.
 * Anything else would start engine work or write the host's journal.
 */
function servedWhileFrozen(frame: Record<string, unknown>) {
  switch (frame.type) {
    case "hello":
    case "ping":
    case "mcp_inventory":
    case "background_work":
    case "prompt_receipt":
    case "quiesce":
    case "release_quiesce":
      return true;
    case "shutdown":
      return typeof frame.quiesceId === "string" || frame.idleOnly === true;
    default:
      return false;
  }
}

/**
 * The caller's side of a host channel through the fence: while frozen, a
 * frame that writes is dropped before it reaches the host (admission only
 * gates new requests; this gates channels opened before the freeze).
 */
function fencedWrites(
  channel: Duplex,
  frozen: () => boolean,
  dropped: (type: unknown) => void
): Duplex {
  const decode = frameDecoder();
  const fenced: Duplex = new Duplex({
    allowHalfOpen: false,
    read() {
      channel.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (channel.destroyed) return callback(new Error("Channel closed"));
      const allowed = decode(chunk).filter((frame) => {
        if (!frozen() || servedWhileFrozen(frame)) return true;
        dropped(frame.type);
        return false;
      });
      if (!allowed.length) return callback();
      channel.write(
        allowed.map((frame) => JSON.stringify(frame) + "\n").join(""),
        (error) => callback(error ?? null)
      );
    },
    final(callback) {
      channel.end();
      callback();
    },
    destroy(error, callback) {
      channel.destroy();
      callback(error);
    },
  });
  channel.on("data", (chunk: Buffer) => {
    if (!fenced.push(chunk)) channel.pause();
  });
  channel.once("end", () => fenced.push(null));
  channel.once("close", () => fenced.destroy());
  channel.on("error", () => fenced.destroy());
  return fenced;
}

function keyOf(session: Req<"session.alive">["session"]) {
  const key = sessionToWire(session);
  if (!validKey(key))
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid session state directory",
    });
  return key;
}

const exists = (file: string) =>
  open(file, "r").then(
    async (handle) => {
      await handle.close();
      return true;
    },
    () => false
  );

/** The last `lines` lines of a log, as older builds read them. */
async function logTail(file: string, lines: number) {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_WINDOW_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let first = 0;
    while (start > 0 && first < bytesRead && (buffer[first]! & 0xc0) === 0x80)
      first++;
    const text = buffer.toString("utf8", first, bytesRead).trim();
    return text ? text.split("\n").slice(-lines).join("\n") : "";
  } finally {
    await handle.close();
  }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(
      () => socket.destroy(new Error("connect timed out")),
      CONNECT_TIMEOUT_MS
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function localSessionHandlers(
  options: LocalSessionOptions
): Handlers & { stop(): Promise<void>; liveCount(): Promise<number> } {
  const layout = posixUserLayout(options.root);
  const entry: PosixHostEntry = options.command
    ? { ...options.entry, command: () => [...options.command!] }
    : options.entry;
  const processes = posixUserProcesses(layout, entry);
  const frozen = () => options.fence?.frozen === true;
  const core = (options.createSessions ?? createSessionCore)({
    processes,
    layout,
    state: posixUserState,
    mayRun: () => !frozen(),
    // The child is the only spawner: hosts that exited while no runner
    // watched them are cleaned, never one a marker scan still finds.
    sweepMs: options.sweepMs,
  });
  const identityOf = (key: string) => core.readIdentity(key).catch(() => null);

  /**
   * Wait until the host for `key` records itself live, or is gone: no
   * recorded pid and no process carrying its marker. True when live.
   */
  async function started(
    key: string,
    marker: string,
    exited: (() => boolean) | null
  ) {
    const dir = layout.hostDir(key);
    const deadline = Date.now() + START_WAIT_MS;
    for (let polls = 0; ; polls++) {
      if (liveHost(dir)) return true;
      if (exited?.()) return false;
      // A host this runner did not spawn has no exit event: scan for it,
      // only now and then (the scan reads every process).
      if (
        !exited &&
        polls % 20 === 19 &&
        !markedHostRunning(entry, marker, dir)
      )
        return liveHost(dir);
      if (Date.now() > deadline) return true; // Still starting: the caller's connect decides.
      await sleep(50);
    }
  }

  const hostExited = () =>
    new RunnerCallError({
      code: "failed",
      message: "the agent host exited before it answered",
    });

  /** Whether a host for `key` runs: recorded live or still starting. */
  const running = async (key: string) => {
    if (liveHost(layout.hostDir(key))) return true;
    const identity = await identityOf(key);
    return (
      !!identity && markedHostRunning(entry, identity.marker, identity.dir)
    );
  };
  /** Whether any build left a record of a host for this key. */
  const known = async (key: string) =>
    (
      await Promise.all(
        [
          POSIX_HOST_FILES.ownership,
          POSIX_HOST_FILES.pid,
          POSIX_HOST_FILES.launch,
        ].map((name) => exists(join(layout.hostDir(key), name)))
      )
    ).some(Boolean);

  async function list() {
    const sessions = [];
    for (const key of await core.trackedKeys()) {
      const { state } = await inspectHostDir(layout.hostDir(key));
      sessions.push({ session: sessionFromWire(key), state });
    }
    return sessions;
  }

  return {
    /** Live hosts, as `session.list` reads them: the update boundary's count. */
    async liveCount() {
      return (await list()).filter((entry) => entry.state === "live").length;
    },
    calls: {
      /**
       * Start the host with the files and argv every build uses. The launch
       * ID is saved before any process starts: a repeat (its answer was lost,
       * the runner restarted) answers for the host it already started, which
       * is still found by its marker before it records its pid.
       */
      async "session.launch"(request) {
        const key = keyOf(request.session);
        // The directory the caller names, else the session's binding.
        const cwd = request.directory
          ? displayPath(request.directory)
          : await options.boundDirectory?.(key);
        if (!cwd)
          throw new RunnerCallError({
            code: "not_found",
            message: "The session has no directory to start in",
          });
        return core.lock(key, async () => {
          const dir = layout.hostDir(key);
          const record = await core.readLaunch(key);
          const identity = await identityOf(key);
          if (
            identity &&
            (liveHost(dir) ||
              markedHostRunning(entry, identity.marker, identity.dir))
          ) {
            if (
              record?.launchId === request.launchId &&
              record.stage === "spawning"
            ) {
              if (await started(key, identity.marker, null)) return {};
              throw hostExited();
            }
          }
          // A host asked to stop may still be exiting; never start a second.
          const deadline = Date.now() + STOP_GRACE_MS;
          while ((await running(key)) && Date.now() < deadline)
            await sleep(100);
          if (await running(key))
            throw new RunnerCallError({
              code: "conflict",
              message: "A host is already running for this session",
            });
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await core.saveLaunch(key, {
            launchId: request.launchId,
            stage: "preparing",
          });
          await entry.prepare(dir, {
            ...request,
            directory: pathFromWire(cwd),
          });
          await core.saveLaunch(key, {
            launchId: request.launchId,
            stage: "spawning",
          });
          let exited = false;
          try {
            await core.spawn(
              key,
              () => hostCommandFor(entry, dir),
              cwd,
              entry.env(),
              {},
              () => {
                exited = true;
              }
            );
          } catch (error) {
            // No process (a missing directory, say): the launch fails as
            // older builds failed it, and its record is removed.
            process.stderr.write(
              `local-runner: host spawn failed: ${(error as Error).message}\n`
            );
            await core.clean(key, await identityOf(key));
            throw hostExited();
          }
          const marker = (await identityOf(key))?.marker;
          if (!marker || !(await started(key, marker, () => exited)))
            throw hostExited();
          return {};
        });
      },
      /**
       * Stop the host as older builds did: the grace period for it to exit
       * by itself (none when forced), then SIGTERM, then SIGKILL, then its
       * marked descendants and records. `idleOnly` never signals: a host
       * still running after the grace is `busy`.
       */
      async "session.stop"({ session, force, idleOnly }) {
        const key = keyOf(session);
        return core.lock(key, async () => {
          const dir = layout.hostDir(key);
          if (idleOnly) {
            const deadline = Date.now() + STOP_GRACE_MS;
            while (liveHost(dir) && Date.now() < deadline) await sleep(100);
            if (liveHost(dir))
              throw new RunnerCallError({
                code: "busy",
                message: "The host is still running",
              });
          }
          const identity = await identityOf(key);
          // A host still starting (its runner died before it answered) has
          // no pid to signal yet: wait for it, so it is not left behind.
          if (
            identity &&
            !liveHost(dir) &&
            markedHostRunning(entry, identity.marker, identity.dir)
          )
            await started(key, identity.marker, null);
          if (identity) await core.stop(key, force);
          else {
            // A host with no marker record is stopped by its pid alone.
            if (liveHost(dir)) await processes.stop({ marker: "", dir }, force);
            for (const name of [POSIX_HOST_FILES.socket, POSIX_HOST_FILES.pid])
              await unlink(join(dir, name)).catch(() => {});
          }
          await core.removeLaunch(key);
          return {};
        });
      },
      /** Remove the session's directory; a running host is `busy`. */
      async "session.discard"({ session }) {
        const key = keyOf(session);
        return core.lock(key, async () => {
          if (await running(key))
            throw new RunnerCallError({
              code: "busy",
              message: "The host is still running",
            });
          await rm(layout.hostDir(key), { recursive: true, force: true });
          return {};
        });
      },
      async "session.alive"({ session }) {
        const { state } = await inspectHostDir(layout.hostDir(keyOf(session)));
        return { state };
      },
      async "session.logs"({ session, lines }) {
        const key = keyOf(session);
        const file = layout.logFile(key);
        if (!(await exists(file)) && !(await known(key)))
          throw new RunnerCallError({
            code: "not_found",
            message: "No such session",
          });
        return { text: await logTail(file, Math.max(0, lines)) };
      },
      "session.list": async () => ({ sessions: await list() }),
    },
    opens: {
      /**
       * A connection to the host, as the app made it: the socket is dialled
       * whatever the records say, and a host that does not answer is an
       * ordinary failure the caller retries. Only a session no build ever
       * recorded is `host_gone`. Frames are decoded to the contract (the
       * agent id dropped); the caller's frames go to the host unchanged.
       */
      async "session.attach"({ session }) {
        const key = keyOf(session);
        const socket = await core.lock(key, async () => {
          try {
            return await connect(layout.socket(key));
          } catch (error) {
            if (!(await known(key)))
              throw new RunnerCallError({
                code: "host_gone",
                message: "No host was started for this session",
              });
            // A host that is not running at all (stopped, or exited) is
            // gone; one that runs but does not answer yet is retried.
            if (!(await running(key)))
              throw new RunnerCallError({
                code: "host_gone",
                message: "The session's host is not running",
              });
            throw error;
          }
        });
        return {
          info: {},
          channel: fencedWrites(
            mapIncomingFrames(socket, (frame) =>
              decodeSessionFrame(frame, key)
            ),
            frozen,
            (type) =>
              process.stderr.write(
                `local-runner: dropped a ${String(type)} frame while frozen\n`
              )
          ),
        };
      },
    },
    async stop() {
      core.close();
    },
  };
}
