/*
 * The local runner's session family over the session core and the
 * `posix-user` ports. It tracks the hosts under the agent state root from
 * the records every build writes, so hosts an older build or the app
 * started are adopted as they are found: nothing is probed, signalled or
 * rewritten to adopt them.
 *
 * Today the family is read-only: attach, alive, logs and list. The app still
 * starts and stops local hosts; exactly one of the two may, so launch, stop
 * and discard stay unsupported here, and the core's descendant sweep stays
 * off (it removes records and processes) until this runner is the only one
 * that starts hosts.
 */
import { open } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  RunnerCallError,
  sessionFromWire,
  sessionToWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import {
  decodeSessionFrame,
  mapIncomingFrames,
} from "@dispatch/runner-client/v1/host";
import type { Handlers } from "./socket-server.js";
import {
  createSessionCore,
  type SessionCoreFactory,
} from "../core/sessions.js";
import {
  POSIX_HOST_FILES,
  inspectHostDir,
  posixUserLayout,
  posixUserProcesses,
  posixUserState,
  validKey,
  type PosixHostEntry,
} from "../platform/posix-user/sessions.js";

const CONNECT_TIMEOUT_MS = 5_000;
/** The most log a `session.logs` answer reads from the end of the file. */
const LOG_WINDOW_BYTES = 256 * 1024;

export type LocalSessionOptions = {
  /** The agent state root, exactly as the app names it in host commands. */
  root: string;
  entry: PosixHostEntry;
  createSessions?: SessionCoreFactory;
};

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
): Handlers & { stop(): Promise<void> } {
  const layout = posixUserLayout(options.root);
  const core = (options.createSessions ?? createSessionCore)({
    processes: posixUserProcesses(layout, options.entry),
    layout,
    state: posixUserState,
    sweepMs: null,
  });
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

  return {
    calls: {
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
      async "session.list"() {
        const sessions = [];
        for (const key of await core.trackedKeys()) {
          const { state } = await inspectHostDir(layout.hostDir(key));
          sessions.push({ session: sessionFromWire(key), state });
        }
        return { sessions };
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
            throw error;
          }
        });
        return {
          info: {},
          channel: mapIncomingFrames(socket, (frame) =>
            decodeSessionFrame(frame, key)
          ),
        };
      },
    },
    async stop() {
      core.close();
    },
  };
}
