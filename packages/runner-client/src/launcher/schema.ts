/*
 * The launcher channel: a pipe from a parent process to the runner it starts.
 * It is not part of `Runner`, is never reachable over a socket or TLS, and
 * carries exactly these messages:
 *
 * - parent → runner `start`, runner → parent `ready`: configuration and the
 *   exact build handshake.
 * - EOF on the parent's end: the lifeline. The runner stops accepting, ends
 *   its own work and exits. It never stops detached hosts.
 * - parent → runner `freeze` / `thaw`: the updater's write fence.
 * - parent → runner `import`: one-time bindings for sessions from older builds.
 *
 * A refusal is not a message: the runner writes one line to stderr and exits
 * with one of `launcherExit`, so the parent can name the reason.
 *
 * `launcherSurface()` is snapshotted in `launcher-surface.json` (E8). No
 * product operation may be added here.
 */
import {
  array,
  build,
  integer,
  json,
  literal,
  object,
  string,
  union,
  type Infer,
  type Shape,
} from "@dispatch/runner-protocol/contract";

/** Version of the launcher channel. Both ends must match exactly. */
export const LAUNCHER_PROTOCOL = 1;

export const launcherStart = object({
  type: literal("start"),
  build,
  protocol: integer,
  /** Chosen per spawn; a socket connection must present it. */
  nonce: string,
  /** `state` keys the runner's exclusive lock. */
  roots: object({ state: string, files: string }),
  config: object({
    runnerId: string,
    displayName: string,
    engines: array(string),
  }),
});

export const launcherReady = object({
  type: literal("ready"),
  build,
  protocol: integer,
  nonce: string,
  /** The local socket path, in a private runtime directory. */
  socket: string,
});

export const launcherFreeze = object({ type: literal("freeze") });
export const launcherThaw = object({ type: literal("thaw") });
/** Bindings are typed when the runner keeps them (L4); until then the runner accepts and ignores them. */
export const launcherImport = object({
  type: literal("import"),
  bindings: array(json),
});

/** Every parent → runner message after `start`. */
export const launcherCommand = union(
  launcherFreeze,
  launcherThaw,
  launcherImport
);

export type LauncherStart = Infer<typeof launcherStart>;
export type LauncherReady = Infer<typeof launcherReady>;
export type LauncherCommand = Infer<typeof launcherCommand>;

/** Exit codes a runner uses to refuse a start, with stderr naming the detail. */
export const launcherExit = {
  /** The start message was missing or malformed. */
  invalid: 64,
  /** The state root is held by another live parent's runner. */
  locked: 75,
  /** The runner's build or launcher protocol differs from the parent's. */
  mismatch: 78,
} as const;
export type LauncherRefusal = keyof typeof launcherExit;

/** The launcher channel as data, for the committed snapshot. */
export function launcherSurface(): {
  protocol: number;
  toRunner: Record<string, Shape>;
  fromRunner: Record<string, Shape>;
  lifeline: string;
  exit: Record<string, number>;
} {
  return {
    protocol: LAUNCHER_PROTOCOL,
    toRunner: {
      start: launcherStart.shape,
      freeze: launcherFreeze.shape,
      thaw: launcherThaw.shape,
      import: launcherImport.shape,
    },
    fromRunner: { ready: launcherReady.shape },
    lifeline: "eof",
    exit: { ...launcherExit },
  };
}
