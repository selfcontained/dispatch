import { closeSync, writeSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { realpath, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { Duplex, PassThrough } from "node:stream";
import {
  isTerminalControl,
  MAX_TERMINAL_FRAME_LENGTH,
  TERMINAL_REPLAY_BYTES,
  type TerminalEvent,
  type TerminalInfo,
} from "@dispatch/runner-protocol";
import {
  displayPath,
  pathFromWire,
  RunnerCallError,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { wireFrames } from "../runners/enrolled/v1-framing.js";
import { spawnTerminal, type PtyProcess } from "./pty.js";

type TerminalWorkerEvent =
  | TerminalEvent
  | { type: "ready"; info: TerminalInfo };

/** Runs with the configured workload UID, GID and home. */
export async function runTerminalWorker(cwd: string) {
  const io = Duplex.from({ readable: process.stdin, writable: process.stdout });
  let detached = false;
  let replay = Buffer.alloc(0);
  const { uid, username } = userInfo();
  const info = {
    cwd,
    host: hostname(),
    user: username === "unknown" ? `uid ${uid}` : username,
  };
  let pty: PtyProcess | undefined;
  const send = wireFrames<unknown, TerminalWorkerEvent>(
    io,
    (message) => {
      if (!isTerminalControl(message))
        throw new Error("Invalid terminal control.");
      if (!pty) throw new Error("Terminal has not started.");
      switch (message.type) {
        case "input":
          if (
            !detached &&
            pty.terminal.write(message.data) < Buffer.byteLength(message.data)
          ) {
            send({ type: "error", message: "Terminal input buffer full." });
            io.end();
          }
          break;
        case "resize":
          if (!detached) pty.terminal.resize(message.cols, message.rows);
          break;
        case "detach":
          detached = true;
          break;
        case "resume":
          detached = false;
          if (replay.length)
            send({ type: "output", data: replay.toString("base64") });
          replay = Buffer.alloc(0);
          break;
      }
    },
    MAX_TERMINAL_FRAME_LENGTH
  );
  const close = () => io.destroy();
  const cleanup = () => {
    process.off("SIGTERM", close);
    process.stdin.destroy();
    try {
      pty?.kill();
    } catch {
      // The shell may already have exited.
    }
  };
  process.once("SIGTERM", close);
  io.on("error", close);
  io.on("finish", close);
  io.once("close", cleanup);
  try {
    pty = spawnTerminal(
      cwd,
      (data) => {
        const bytes = Buffer.from(data);
        if (detached) {
          replay = Buffer.concat([replay, bytes]).subarray(
            -TERMINAL_REPLAY_BYTES
          );
        } else if (!io.destroyed) {
          try {
            send({ type: "output", data: bytes.toString("base64") });
          } catch {
            io.destroy();
          }
        }
      },
      process.env.SHELL || "/bin/bash"
    );
  } catch (error) {
    close();
    throw error;
  }
  send({ type: "ready", info });
  const code = await pty.exited;
  if (!io.destroyed && !io.writableEnded) {
    try {
      send({ type: "exit", code });
      io.end();
    } catch {
      io.destroy();
    }
  }
}

/** The supervisor gives this workload process a dedicated readiness pipe. Stdin
 * remains a lifeline, including when the supervisor dies without signalling. */
export async function runTypedTerminalWorker(
  cwd: string,
  cols: number,
  rows: number
) {
  const handlers = localTerminalHandlers(process.env.SHELL);
  const stop = () => {
    void handlers.stop();
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.once("error", stop);
  process.once("SIGTERM", stop);
  try {
    const { info, channel } = await handlers.opens["terminal.open"]({
      target: { path: pathFromWire(cwd) },
      cols,
      rows,
    });
    writeSync(3, JSON.stringify(info));
    closeSync(3);
    process.stdin.pipe(channel);
    await pipeline(channel, process.stdout).catch(() => {});
  } finally {
    await handlers.stop();
    process.stdin.destroy();
    process.off("SIGTERM", stop);
  }
}

/** The local runner owns the shell and its process session for this channel. */
export function localTerminalHandlers(shell?: string) {
  let stopping = false;
  const active = new Map<Duplex, Promise<number>>();

  async function open({ target, cols, rows }: Req<"terminal.open">) {
    if (
      !("path" in target) ||
      !isTerminalControl({ type: "resize", cols, rows })
    )
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native terminal binding.",
      });
    const cwd = await realpath(displayPath(target.path));
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Workspace directory is unavailable.");
    if (stopping) throw new Error("The local runner is unavailable");

    const info = { cwd, host: hostname(), user: userInfo().username };
    let pty: PtyProcess | undefined;
    const channel = new Duplex({
      allowHalfOpen: false,
      read() {},
      write(chunk, _encoding, callback) {
        controls.write(chunk, callback);
      },
      final(callback) {
        channel.destroy();
        callback();
      },
      destroy(error, callback) {
        controls.destroy();
        try {
          pty?.kill();
        } catch {
          // The shell may already have exited.
        }
        callback(error);
      },
    });
    const send = (event: TerminalEvent) => {
      if (!channel.destroyed) channel.push(JSON.stringify(event) + "\n");
    };
    const controls = new PassThrough();
    controls.once("close", () => channel.destroy());
    wireFrames<unknown>(
      controls,
      (message) => {
        if (!isTerminalControl(message) || !pty)
          throw new Error("Invalid terminal control.");
        if (message.type === "resize") {
          pty.terminal.resize(message.cols, message.rows);
        } else if (message.type === "input") {
          if (
            pty.terminal.write(message.data) < Buffer.byteLength(message.data)
          )
            send({ type: "error", message: "Terminal input buffer full." });
        }
      },
      MAX_TERMINAL_FRAME_LENGTH
    );

    try {
      pty = spawnTerminal(
        cwd,
        (data) =>
          send({ type: "output", data: Buffer.from(data).toString("base64") }),
        undefined,
        { cols, rows, shell }
      );
    } catch (error) {
      channel.destroy();
      throw error;
    }
    const exited = pty.exited.then((code) => {
      try {
        pty.kill();
      } finally {
        send({ type: "exit", code });
        if (!channel.destroyed) channel.push(null);
        active.delete(channel);
      }
      return code;
    });
    active.set(channel, exited);
    void exited.catch(() => channel.destroy());
    return { info, channel };
  }

  return {
    calls: {},
    opens: { "terminal.open": open },
    async stop() {
      stopping = true;
      for (const channel of active.keys()) channel.destroy();
      await Promise.allSettled(active.values());
    },
  };
}
