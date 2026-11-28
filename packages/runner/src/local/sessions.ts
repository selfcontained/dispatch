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
import { mkdir, open, readdir, rm, unlink } from "node:fs/promises";
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
import type { ConnectionContext, Handlers } from "./socket-server.js";
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
  scanMarkedHost,
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
  /** Retire the stopped session binding after its checkout decision is complete. */
  retireBinding?: (key: string) => Promise<void>;
  /** Release managed repository checkouts before their recovery records go away. */
  discardWorkspace?: (
    session: Req<"session.discard">["session"],
    context: ConnectionContext
  ) => Promise<void>;
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
    exited: (() => boolean) | null,
    scan = markedHostRunning
  ) {
    const dir = layout.hostDir(key);
    const deadline = Date.now() + START_WAIT_MS;
    for (let polls = 0; ; polls++) {
      if (liveHost(dir)) return true;
      if (exited?.()) return false;
      // A host this runner did not spawn has no exit event: scan for it,
      // only now and then (the scan reads every process).
      if (!exited && polls % 20 === 19 && !scan(entry, marker, dir))
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

  async function list(owner: string | null = null) {
    const sessions = [];
    for (const key of await core.trackedKeys()) {
      const launch = await core.readLaunch(key);
      if (owner !== null && launch?.owner !== owner) continue;
      const { state } = await inspectHostDir(layout.hostDir(key));
      const identity = await identityOf(key);
      sessions.push({
        session: sessionFromWire(key),
        state,
        ...(state === "live" &&
          launch?.stage === "spawning" &&
          identity &&
          launch.hostInstanceId === identity.marker && {
            launchId: launch.launchId,
          }),
      });
    }
    return sessions;
  }

  async function discardSession(
    session: Req<"session.discard">["session"],
    context: ConnectionContext,
    retainCheckout: boolean,
    checkoutPending = false
  ) {
    const key = keyOf(session);
    return core.lock(key, async () => {
      if (await running(key))
        throw new RunnerCallError({
          code: "busy",
          message: "The host is still running",
        });
      if (!retainCheckout) await options.discardWorkspace?.(session, context);
      await core.removeLaunch(key);
      if (checkoutPending) {
        // Local preparation receipts share the host directory. Keep only the
        // recovery receipt until the checkout decision can complete.
        for (const file of await readdir(layout.hostDir(key)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }))
          if (file !== "workspace-preparation")
            await rm(join(layout.hostDir(key), file), {
              recursive: true,
              force: true,
            });
      } else {
        await options.retireBinding?.(key);
        await rm(layout.hostDir(key), { recursive: true, force: true });
      }
      return {};
    });
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
              record.stage === "spawning" &&
              (record.owner === undefined || record.owner === request.owner) &&
              (record.hostInstanceId === undefined ||
                record.hostInstanceId === identity.marker)
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
            ...(request.owner !== null && { owner: request.owner }),
          });
          await entry.prepare(dir, {
            ...request,
            directory: pathFromWire(cwd),
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
              },
              (identity) =>
                core.saveLaunch(key, {
                  launchId: request.launchId,
                  stage: "spawning",
                  hostInstanceId: identity.marker,
                  ...(request.owner !== null && { owner: request.owner }),
                })
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
      async "session.stop"({
        session,
        force,
        idleOnly,
        expectedLaunchId,
        expectedOwner,
      }) {
        const key = keyOf(session);
        return core.lock(key, async () => {
          const identity = await identityOf(key);
          if (expectedOwner !== undefined && expectedLaunchId === undefined)
            return {};
          if (expectedLaunchId !== undefined) {
            const launch = await core.readLaunch(key);
            if (
              launch?.launchId !== expectedLaunchId ||
              (expectedOwner !== undefined &&
                (launch.owner !== expectedOwner ||
                  launch.stage !== "spawning" ||
                  launch.hostInstanceId === undefined)) ||
              (launch.hostInstanceId !== undefined &&
                launch.hostInstanceId !== identity?.marker)
            )
              return {};
          }
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
          // A host still starting (its runner died before it answered) has
          // no pid to signal yet: wait for it, so it is not left behind.
          if (
            identity &&
            !liveHost(dir) &&
            scanMarkedHost(entry, identity.marker, identity.dir)
          )
            await started(key, identity.marker, null, scanMarkedHost);
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
      async "session.discard"({ session }, context) {
        return discardSession(session, context, false);
      },
      async "session.retire"({ session, checkoutPending }, context) {
        return discardSession(session, context, true, checkoutPending);
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
      "session.list": async ({ owner }) => ({
        sessions: await list(owner),
      }),
      async "session.sample"({ sessions }) {
        const entries = await Promise.all(
          [...new Set(sessions)].map(async (session) => {
            const { pid } = await inspectHostDir(
              layout.hostDir(keyOf(session))
            );
            return [session, pid] as const;
          })
        );
        return {
          samples: await core.sample(
            new Map(
              entries.flatMap(([session, pid]) =>
                pid === null ? [] : [[session, pid]]
              )
            )
          ),
        };
      },
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
