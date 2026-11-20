import { hostname, userInfo } from "node:os";
import { Duplex } from "node:stream";
import {
  isTerminalControl,
  MAX_TERMINAL_FRAME_LENGTH,
  TERMINAL_REPLAY_BYTES,
  type TerminalEvent,
  type TerminalInfo,
} from "@dispatch/runner-protocol";
import { wireFrames } from "@dispatch/runner-protocol/node";
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
    pty = spawnTerminal(cwd, (data) => {
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
    });
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
