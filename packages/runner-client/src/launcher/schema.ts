/*
 * The launcher channel: a pipe from a parent process to the runner it starts.
 * It is not part of `Runner`, is never reachable over a socket or TLS, and
 * carries exactly these messages:
 *
 * - parent → runner `start`, runner → parent `ready`: configuration and the
 *   exact build handshake.
 * - EOF on the parent's end: the lifeline. The runner stops accepting, ends
 *   its own work and exits. It never stops detached hosts.
 * - parent → runner `freeze` / `thaw`, runner → parent `fence`: the
 *   updater's write fence. Each carries a sequence number; the runner answers
 *   `fence` once the state is in force (for `freeze`: no write in flight, and
 *   every later write refused with `fenced`). A runner started with
 *   `frozen: true` is frozen before it serves anything, and says so in
 *   `ready`.
 * - parent → runner `import`, runner → parent `imported`: one-time bindings
 *   for sessions an older build started. A binding the runner already holds
 *   is never replaced, so the parent may send the same list at every start.
 *   The runner decides ownership itself (see `launcherBinding`) and, while
 *   frozen, stores nothing and says so.
 *
 * A refusal is not a message: the runner writes one line to stderr and exits
 * with one of `launcherExit`, so the parent can name the reason.
 *
 * `launcherSurface()` is snapshotted in `launcher-surface.json` (E8). No
 * product operation may be added here.
 */
import {
  array,
  boolean,
  build,
  integer,
  nullable,
  literal,
  object,
  optional,
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
    /** The session host's argv, before its state argument; the runner's own when absent. */
    hostCommand: optional(array(string)),
  }),
  /** Start frozen (an update's probation start): refuse writes until `thaw`. */
  frozen: optional(boolean),
});

export const launcherReady = object({
  type: literal("ready"),
  build,
  protocol: integer,
  nonce: string,
  /** The local socket path, in a private runtime directory. */
  socket: string,
  /** Whether the runner is frozen as it starts serving. */
  frozen: boolean,
});

export const launcherFreeze = object({ type: literal("freeze"), seq: integer });
export const launcherThaw = object({ type: literal("thaw"), seq: integer });
/** The runner's answer to `freeze`/`thaw` `seq`, once that state is in force. */
export const launcherFence = object({
  type: literal("fence"),
  seq: integer,
  frozen: boolean,
});
/**
 * One session's checkout as an older build recorded it: facts, not a
 * decision. The runner records the checkout as its own (removable later)
 * only when `worktree` is given AND Git says that path is the root of a
 * linked worktree; anything else is external and is never deleted, and a
 * missing directory is recorded as gone.
 */
export const launcherBinding = object({
  /** The session's opaque handle. */
  session: string,
  /** The checkout the session was started in. */
  path: string,
  /** A directory the session later moved itself into, if any. */
  currentPath: nullable(string),
  /** A linked worktree the parent created for this session, if it did. */
  worktree: nullable(
    object({ path: string, branch: nullable(string), base: nullable(string) })
  ),
});

export const launcherImport = object({
  type: literal("import"),
  seq: integer,
  bindings: array(launcherBinding),
});
/**
 * The runner's answer to `import` `seq`: how many bindings it stored, how
 * many it already held (left unchanged) and how many it could not read. A
 * frozen runner stores nothing and answers `frozen: true`. Answers follow
 * the same order as `freeze`/`thaw`.
 */
export const launcherImported = object({
  type: literal("imported"),
  seq: integer,
  added: integer,
  kept: integer,
  invalid: integer,
  frozen: boolean,
  /** Set when storing failed part-way; the bindings stored before it stay. */
  error: optional(string),
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
export type LauncherFence = Infer<typeof launcherFence>;
export type LauncherBinding = Infer<typeof launcherBinding>;
export type LauncherImported = Infer<typeof launcherImported>;

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
    fromRunner: {
      ready: launcherReady.shape,
      fence: launcherFence.shape,
      imported: launcherImported.shape,
    },
    lifeline: "eof",
    exit: { ...launcherExit },
  };
}
