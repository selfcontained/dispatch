import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  LAUNCHER_PROTOCOL,
  launcherExit,
  launcherFence,
  launcherReady,
  type LauncherCommand,
  type LauncherReady,
  type LauncherRefusal,
  type LauncherStart,
} from "./schema.js";

/**
 * This executable plus one of its modes. Under `bun main.ts` that is the
 * runtime plus the script; a compiled binary is itself.
 */
export function selfCommand(mode: string): string[] {
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script) && existsSync(script))
    return [process.execPath, script, mode];
  return [process.execPath, mode];
}

export type LaunchSpec = {
  /** argv, the program first. */
  command: string[];
  /** The complete environment of the child: nothing else is inherited. */
  env: Record<string, string | undefined>;
  start: Omit<LauncherStart, "type" | "nonce" | "protocol">;
  readyTimeoutMs?: number;
  /** Each line the runner writes to stderr. */
  onStderr?: (line: string) => void;
};

export type LauncherFailure = LauncherRefusal | "timeout" | "exited";

export class LauncherError extends Error {
  constructor(
    readonly reason: LauncherFailure,
    message: string
  ) {
    super(message);
    this.name = "LauncherError";
  }
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

export interface LaunchedRunner {
  readonly pid: number;
  readonly ready: LauncherReady;
  readonly exited: Promise<ExitInfo>;
  send(command: LauncherCommand): void;
  /**
   * Freeze (`true`) or thaw (`false`) the runner's writes and wait for its
   * `fence` answer. Rejects when no answer arrives within `timeoutMs` or the
   * runner exits first: the caller then cannot know the runner's state.
   */
  fence(frozen: boolean, timeoutMs: number): Promise<void>;
  /** Close the lifeline; SIGKILL after `graceMs` if the runner has not exited. */
  close(graceMs: number): Promise<ExitInfo>;
}

const refusalByCode = new Map<number, LauncherRefusal>(
  Object.entries(launcherExit).map(([reason, code]) => [
    code,
    reason as LauncherRefusal,
  ])
);

function sameBuild(a: LauncherStart["build"], b: LauncherStart["build"]) {
  return (
    a.version === b.version && (a.revision ?? null) === (b.revision ?? null)
  );
}

/** Spawn one runner and complete the handshake. */
export function launchRunner(spec: LaunchSpec): Promise<LaunchedRunner> {
  const [program, ...args] = spec.command;
  if (!program) throw new Error("Runner command is empty");
  const nonce = randomUUID();
  const start: LauncherStart = {
    type: "start",
    protocol: LAUNCHER_PROTOCOL,
    nonce,
    ...spec.start,
  };
  const child: ChildProcess = spawn(program, args, {
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Spawn failures (ENOENT) arrive as `error` with no `exit`.
  const spawnFailed = new Promise<Error>((resolve) =>
    child.once("error", resolve)
  );
  let lastStderr = "";
  lines(child.stderr!, (line) => {
    lastStderr = line;
    spec.onStderr?.(line);
  });
  child.stdin!.on("error", () => {}); // EPIPE when the runner has exited.
  // `fence` answers after the handshake, by sequence number.
  let fenceSeq = 0;
  const fences = new Map<
    number,
    { frozen: boolean; resolve(): void; reject(error: Error): void }
  >();
  const fenceAnswer = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!launcherFence.check(message)) return;
    const pending = fences.get(message.seq);
    if (!pending) return;
    fences.delete(message.seq);
    if (message.frozen === pending.frozen) pending.resolve();
    else pending.reject(new Error("The runner answered the other fence state"));
  };
  void exited.then(() => {
    for (const pending of fences.values())
      pending.reject(new Error("The runner exited before answering"));
    fences.clear();
  });
  child.stdin!.write(JSON.stringify(start) + "\n");

  const handshake = new Promise<LauncherReady>((resolve, reject) => {
    let settled = false;
    const fail = (error: LauncherError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new LauncherError(
            "timeout",
            `Runner did not become ready within ${spec.readyTimeoutMs ?? 10_000} ms`
          )
        ),
      spec.readyTimeoutMs ?? 10_000
    );
    lines(child.stdout!, (line) => {
      if (settled) return fenceAnswer(line);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return fail(
          new LauncherError("invalid", "Runner sent a malformed line")
        );
      }
      if (!launcherReady.check(message))
        return fail(
          new LauncherError("invalid", "Runner sent an invalid ready")
        );
      if (message.nonce !== nonce || message.protocol !== LAUNCHER_PROTOCOL)
        return fail(
          new LauncherError("mismatch", "Runner answered another handshake")
        );
      if (message.frozen !== (start.frozen === true))
        return fail(
          new LauncherError(
            "invalid",
            "Runner did not start in the asked fence state"
          )
        );
      if (!sameBuild(message.build, start.build))
        return fail(
          new LauncherError(
            "mismatch",
            `Runner build ${describeBuild(message.build)} differs from ${describeBuild(start.build)}`
          )
        );
      settled = true;
      clearTimeout(timer);
      resolve(message);
    });
    void spawnFailed.then((error) =>
      fail(
        new LauncherError("exited", `Runner could not start: ${error.message}`)
      )
    );
    void exited.then(({ code, signal }) => {
      // Let stderr drain so the refusal line is the one reported.
      setTimeout(() => {
        const reason = code === null ? undefined : refusalByCode.get(code);
        fail(
          new LauncherError(
            reason ?? "exited",
            lastStderr ||
              `Runner exited before ready (${signal ?? `code ${code}`})`
          )
        );
      }, 20);
    });
  });

  const close = async (graceMs: number) => {
    child.stdin!.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    const info = await exited;
    clearTimeout(timer);
    return info;
  };

  return handshake.then(
    (ready) => ({
      pid: child.pid!,
      ready,
      exited,
      send(command) {
        if (child.stdin!.writable)
          child.stdin!.write(JSON.stringify(command) + "\n");
      },
      fence(frozen, timeoutMs) {
        if (child.exitCode !== null || child.signalCode !== null)
          return Promise.reject(new Error("The runner has exited"));
        const seq = ++fenceSeq;
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            fences.delete(seq);
            reject(
              new Error(
                `The runner did not answer the fence in ${timeoutMs} ms`
              )
            );
          }, timeoutMs);
          const settle =
            <A extends unknown[]>(next: (...args: A) => void) =>
            (...args: A) => {
              clearTimeout(timer);
              next(...args);
            };
          fences.set(seq, {
            frozen,
            resolve: settle(resolve),
            reject: settle(reject),
          });
          child.stdin!.write(
            JSON.stringify({ type: frozen ? "freeze" : "thaw", seq }) + "\n"
          );
        });
      },
      close,
    }),
    async (error) => {
      if (child.exitCode === null && child.signalCode === null)
        await close(0).catch(() => {});
      throw error;
    }
  );
}

export type SupervisorState =
  | { state: "starting" }
  | { state: "ready"; runner: LaunchedRunner }
  | { state: "waiting"; error: Error; retryInMs: number }
  | { state: "stopped" };

export type SupervisorOptions = LaunchSpec & {
  /**
   * Read at each (re)start: a runner started while this is true starts frozen,
   * so a restart during an update fence or probation never serves writes.
   */
  frozen?: () => boolean;
  backoff?: { initialMs?: number; maxMs?: number; stableMs?: number };
  onState?: (state: SupervisorState) => void;
};

export interface RunnerSupervisor {
  readonly state: SupervisorState;
  /** Resolves when the lifeline is closed and the runner has exited. */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Keep one runner running: start it, and restart it with exponential backoff
 * whenever it exits or refuses. Never throws; failures are reported through
 * `onState`. A runner that stayed ready for `stableMs` resets the backoff.
 */
export function superviseRunner(options: SupervisorOptions): RunnerSupervisor {
  const initialMs = options.backoff?.initialMs ?? 500;
  const maxMs = options.backoff?.maxMs ?? 60_000;
  const stableMs = options.backoff?.stableMs ?? 60_000;
  let delayMs = initialMs;
  let state: SupervisorState = { state: "starting" };
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let launching: Promise<unknown> | undefined;

  const set = (next: SupervisorState) => {
    state = next;
    options.onState?.(next);
  };

  const retry = (error: Error) => {
    if (stopping) return;
    const retryInMs = delayMs;
    delayMs = Math.min(delayMs * 2, maxMs);
    set({ state: "waiting", error, retryInMs });
    timer = setTimeout(run, retryInMs);
  };

  function run() {
    timer = undefined;
    if (stopping) return;
    set({ state: "starting" });
    const frozen = options.frozen?.() === true;
    launching = launchRunner({
      ...options,
      start: { ...options.start, ...(frozen && { frozen }) },
    }).then(
      (runner) => {
        if (stopping) return runner.close(2_000);
        const readyAt = Date.now();
        set({ state: "ready", runner });
        void runner.exited.then(({ code, signal }) => {
          if (stopping) return;
          if (Date.now() - readyAt >= stableMs) delayMs = initialMs;
          retry(
            new Error(
              `Runner exited (${signal ?? `code ${code}`}) after it was ready`
            )
          );
        });
      },
      (error: Error) => retry(error)
    );
  }

  run();
  return {
    get state() {
      return state;
    },
    async stop(graceMs = 5_000) {
      stopping = true;
      if (timer) clearTimeout(timer);
      await launching?.catch(() => {});
      if (state.state === "ready") await state.runner.close(graceMs);
      set({ state: "stopped" });
    },
  };
}

function describeBuild(build: LauncherStart["build"]) {
  return build.revision
    ? `${build.version} (${build.revision})`
    : build.version;
}

function lines(stream: NodeJS.ReadableStream, receive: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) receive(line);
    }
    if (pending.length > 1024 * 1024) pending = "";
  });
}
