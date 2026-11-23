/*
 * The session core: one host per session key, the records that name it, and
 * the operations on it (launch records, spawn, attach, alive, stop, discard,
 * logs, list). It owns the per-session lock and the order of every step.
 * The platform supplies how processes are identified, started, signalled
 * and cleaned up (`SessionProcessPort`), where a session's files live
 * (`SessionLayout`), and how private state is written (`PrivateStatePort`).
 * Bindings and checkouts stay with their callers, who take the same lock.
 */
import { closeSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** What a platform records to find a host again: at least its cleanup marker. */
export type HostRecord = { marker: string };

/** A host socket pinned for one connection attempt. */
export type PinnedSocket = { address: string; release(): void };

export interface SessionProcessPort<I extends HostRecord> {
  /** Whether the recorded host is still the same live process. */
  alive(identity: I): boolean;
  /**
   * Whether a host carrying this identity runs though it is not (yet)
   * recorded as live, by a scan of its marker. Cleanup never runs while it
   * does: a starting host may not have written its pid.
   */
  starting?(identity: I): boolean;
  /**
   * Start a detached host. `record` runs once the process is identified and
   * before it may run; `onExit` fires if this process sees it exit.
   */
  spawn(
    command: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    log: number,
    record: (identity: I) => Promise<void>,
    onExit: (identity: I) => void
  ): Promise<void>;
  /** Stop the host: a grace period unless `force`, then its whole session. */
  stop(identity: I, force: boolean): Promise<void>;
  /** Remove every process still carrying the host's marker. */
  cleanup(identity: I): Promise<void>;
  /** The same for a bare marker recorded by an older build. */
  cleanupLegacy(marker: string): Promise<void>;
  /** Whether the host behind `identity` is the process serving `socket`. */
  socketMatchesHost(socket: string, identity: I): boolean;
  /** Whether any process holds a listening socket at this path. */
  socketInUse(socket: string): boolean;
  /** Pin the socket at this path for a single connection. */
  pinSocket(socket: string): PinnedSocket;
  /** Parse the private host record of `key`; throws when it is invalid. */
  parseIdentity(raw: string, key: string): I;
  /**
   * The private host record's contents for `identity` and the caller's
   * `extra` fields; default JSON of both. A platform whose record another
   * build also reads keeps that build's format.
   */
  formatIdentity?(identity: I, extra: Record<string, unknown>): string;
}

export interface SessionLayout {
  /** The host's directory. */
  hostDir(key: string): string;
  /** The socket path a host serves in its directory. */
  socket(key: string): string;
  /** Socket paths a host for this key may have used, the current one first. */
  sockets(key: string): string[];
  /** The private host record. */
  identityFile(key: string): string;
  /** An older build's bare cleanup marker. */
  markerFile(key: string): string;
  /** The private launch record. */
  launchFile(key: string): string;
  /** The host's output log. */
  logFile(key: string): string;
  /** Keys with a host record, read from private state. */
  trackedKeys(): Promise<string[]>;
}

export interface PrivateStatePort {
  read(file: string): Promise<string | null>;
  /** Durable replacement of one file. */
  write(file: string, contents: string): Promise<void>;
  remove(file: string): Promise<void>;
  /** Whether a private record is present, of any type. */
  exists(file: string): Promise<boolean>;
  /** Open a private record for verification without following links. */
  openPrivate(file: string): Promise<PrivateRecord | null>;
}

export type PrivateRecord = {
  /** False when the file is not a regular, owner-only, small file. */
  trusted(): Promise<boolean>;
  read(): Promise<string>;
  close(): Promise<void>;
};

/**
 * One launch attempt's durable identity, saved before the launch starts any
 * process. A repeat of the same ID (its reply was lost) resumes from the
 * stage recorded here instead of running again.
 */
export type LaunchRecord = {
  launchId: string;
  stage: "preparing" | "spawning";
  /** The host this attempt spawned, once it reached `spawning`. */
  hostInstanceId?: string;
  /** Dependency preparation for this attempt. `started` alone is unknown. */
  dependencies?: "started" | "done" | "failed";
};

/** A record that does not parse is no record: the launch runs as new. Its
 * ID is only ever compared with the validated ID on the wire. */
export function parseLaunchRecord(raw: string | null): LaunchRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      (value.stage !== "preparing" && value.stage !== "spawning") ||
      (value.hostInstanceId !== undefined &&
        typeof value.hostInstanceId !== "string")
    )
      return null;
    return {
      launchId: value.launchId as string,
      stage: value.stage,
      ...(value.hostInstanceId !== undefined && {
        hostInstanceId: value.hostInstanceId as string,
      }),
      ...(value.dependencies !== undefined && {
        dependencies: value.dependencies as LaunchRecord["dependencies"],
      }),
    };
  } catch {
    return null;
  }
}

const logTailBytes = 2 * 1024;

/** The last 2 KiB of a log, starting on a whole UTF-8 code point. */
export async function readLogTail(file: string) {
  const handle = await open(file, "r").catch(missing);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - logTailBytes);
    const tail = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(tail, 0, tail.length, start);
    let first = 0;
    // The window may start inside a UTF-8 code point.
    while (start > 0 && first < bytesRead && (tail[first]! & 0xc0) === 0x80)
      first++;
    return tail.toString("utf8", first, bytesRead);
  } finally {
    await handle.close();
  }
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}

export type SessionCoreOptions<I extends HostRecord> = {
  processes: SessionProcessPort<I>;
  layout: SessionLayout;
  state: PrivateStatePort;
  /** False while the update fence holds process admission closed. */
  mayRun?: () => boolean;
  /** How often exited hosts' descendants are swept; null never sweeps. */
  sweepMs?: number | null;
};

export type SessionCore<I extends HostRecord> = ReturnType<
  typeof createSessionCore<I>
>;

export type SessionCoreFactory = <I extends HostRecord>(
  options: SessionCoreOptions<I>
) => SessionCore<I>;

export function createSessionCore<I extends HostRecord>(
  options: SessionCoreOptions<I>
) {
  const { processes, layout, state } = options;
  const operations = new Map<string, Promise<unknown>>();

  /** The session lock: operations on one key run one at a time, in order. */
  function lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = (operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    operations.set(key, pending);
    return pending.finally(() => {
      if (operations.get(key) === pending) operations.delete(key);
    });
  }

  /** Several session locks, acquired in a stable order. */
  function locks<T>(keys: string[], operation: () => Promise<T>) {
    const ordered = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = ordered[index];
      return key === undefined
        ? operation()
        : lock(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async function readIdentity(key: string) {
    const record = await state.read(layout.identityFile(key));
    return record === null ? null : processes.parseIdentity(record, key);
  }

  async function clean(key: string, identity: I | null) {
    if (identity) {
      await processes.cleanup(identity);
      // Unlink only after all known descendants have gone.
      await state.remove(layout.identityFile(key));
    }
  }

  async function cleanLegacy(key: string) {
    const legacy = await state.read(layout.markerFile(key));
    if (legacy) {
      await processes.cleanupLegacy(legacy);
      await state.remove(layout.markerFile(key));
    }
  }

  function hasNamedSocket(key: string) {
    return layout.sockets(key).some((socket) => processes.socketInUse(socket));
  }

  function untrackedSocketError() {
    return new Error(
      "Runner cannot verify ownership of the existing guest host."
    );
  }

  function checkUntrackedSocket(key: string) {
    if (hasNamedSocket(key)) throw untrackedSocketError();
  }

  async function cleanExited(key: string) {
    const current = await readIdentity(key);
    if (current && !processes.alive(current) && !processes.starting?.(current))
      await clean(key, current);
  }

  /**
   * Whether a live host is recorded for this key:
   * `null` none, `undefined` one may be live but cannot be verified,
   * otherwise its record. `verify` runs before the socket is checked.
   */
  async function inspect(
    key: string,
    verify: (identity: I) => Promise<boolean>
  ): Promise<I | null | undefined> {
    try {
      // Private state is authoritative. In particular, never read identity
      // fields or session IDs back from a workload-writable launch file.
      const handle = await state.openPrivate(layout.identityFile(key));
      if (!handle) {
        return hasNamedSocket(key) ||
          (await state.exists(layout.markerFile(key)))
          ? undefined
          : null;
      }
      let identity;
      try {
        if (!(await handle.trusted())) return undefined;
        identity = processes.parseIdentity(await handle.read(), key);
      } finally {
        await handle.close();
      }
      if (!processes.alive(identity))
        return hasNamedSocket(key) ? undefined : null;
      if (!(await verify(identity))) return undefined;
      if (!processes.socketMatchesHost(layout.socket(key), identity))
        return undefined;
      return identity;
    } catch {
      return undefined;
    }
  }

  // Recovered hosts have no ChildProcess exit event. Keep descendant cleanup
  // independent of the service connection and isolate failures by session.
  let sweeping = false;
  const sweepOnce = () => {
    // Cleanup runs workload processes; it waits while the update fence holds.
    if (sweeping || options.mayRun?.() === false) return;
    sweeping = true;
    void layout
      .trackedKeys()
      .then((keys) =>
        Promise.allSettled(keys.map((key) => lock(key, () => cleanExited(key))))
      )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected")
            console.error(
              "Guest host descendant cleanup:",
              result.reason.message
            );
        }
      })
      .catch((error) => console.error("Guest host inventory:", error.message))
      .finally(() => {
        sweeping = false;
      });
  };
  const sweep =
    options.sweepMs === null
      ? undefined
      : setInterval(sweepOnce, options.sweepMs ?? 5_000);
  sweep?.unref();

  return {
    lock,
    locks,
    readIdentity,
    /** The launch record of this key, if it parses. */
    async readLaunch(key: string) {
      return parseLaunchRecord(await state.read(layout.launchFile(key)));
    },
    saveLaunch(key: string, record: LaunchRecord) {
      return state.write(layout.launchFile(key), JSON.stringify(record));
    },
    removeLaunch(key: string) {
      return state.remove(layout.launchFile(key));
    },
    /** Whether the recorded host is live. Caller holds the lock. */
    async alive(key: string) {
      const identity = await readIdentity(key);
      return identity !== null && processes.alive(identity);
    },
    isAlive: (identity: I) => processes.alive(identity),
    clean,
    cleanLegacy,
    checkUntrackedSocket,
    /**
     * Start a host for this key and record it with `extra`. A host that this
     * process sees exit has its descendants cleaned under the lock.
     */
    async spawn(
      key: string,
      /** Resolved after the log opens, as the platform may refuse it. */
      hostCommand: () => string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
      extra: Record<string, unknown>,
      /** Called when this process sees the host exit. */
      exited?: () => void
    ) {
      const log = openSync(layout.logFile(key), "a", 0o600);
      try {
        const command = hostCommand();
        if (!command[0]) throw new Error("Runner host executable is missing");
        await processes.spawn(
          command,
          cwd,
          env,
          log,
          (identity) =>
            state.write(
              layout.identityFile(key),
              processes.formatIdentity?.(identity, extra) ??
                JSON.stringify({ ...identity, ...extra })
            ),
          (identity) => {
            exited?.();
            void lock(key, async () => {
              const current = await readIdentity(key);
              if (
                current?.marker === identity.marker &&
                !processes.alive(current)
              )
                await clean(key, current);
            }).catch((error) =>
              console.error("Guest host descendant cleanup:", error.message)
            );
          }
        );
      } finally {
        closeSync(log);
      }
    },
    /** A connection to the live host, or null when none. Caller holds the lock. */
    async attach(key: string): Promise<Socket | null> {
      const identity = await readIdentity(key);
      if (!identity || !processes.alive(identity)) return null;

      let pinned: PinnedSocket;
      try {
        pinned = processes.pinSocket(layout.socket(key));
      } catch (error) {
        throw new Error("Guest host socket is unavailable", { cause: error });
      }
      try {
        if (!processes.alive(identity)) {
          pinned.release();
          return null;
        }
        const channel = createConnection(pinned.address);
        const releaseSocket = () => {
          channel.off("connect", releaseSocket);
          channel.off("close", releaseSocket);
          pinned.release();
        };
        channel.once("connect", releaseSocket);
        channel.once("close", releaseSocket);
        return channel;
      } catch (error) {
        pinned.release();
        throw error;
      }
    },
    /** Stop the recorded host and clean up after it. Caller holds the lock. */
    async stop(key: string, force: boolean) {
      const identity = await readIdentity(key);
      if (identity) await processes.stop(identity, force);
      await clean(key, identity);
      if (identity) {
        // The recorded host can exit before the kernel drops its socket row.
        const deadline = performance.now() + 500;
        while (hasNamedSocket(key)) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw untrackedSocketError();
          await delay(Math.min(50, remaining));
        }
      } else {
        checkUntrackedSocket(key);
      }
      await cleanLegacy(key);
    },
    /** The host's log tail and whether it is live. */
    async logs(key: string) {
      const identity = await readIdentity(key);
      const live = !!identity && processes.alive(identity);
      return { live, text: await readLogTail(layout.logFile(key)) };
    },
    removeLog(key: string) {
      return state.remove(layout.logFile(key));
    },
    trackedKeys: () => layout.trackedKeys(),
    inspect,
    close() {
      clearInterval(sweep);
    },
  };
}
