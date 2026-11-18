import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { HostLaunch } from "../acp/host-protocol.js";

export function remotePlacement(cwd: string) {
  const match = /^runner:\/\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(cwd);
  return match ? { runner: match[1]!, workspace: match[2]! } : null;
}

export type Placement = NonNullable<ReturnType<typeof remotePlacement>>;
export type RemoteLaunch = Omit<
  HostLaunch,
  "cwd" | "bins" | "env" | "pathPrefix"
>;

export type Command = { agentId: string; workspace: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" | "repo" }
  | { kind: "stop"; force: boolean }
);
export type Frame =
  | { type: "ready"; version: 1; workspaces: string[] }
  | { type: "request"; id: string; command: Command }
  | {
      type: "result";
      id: string;
      value?: boolean | string;
      error?: string;
      code?: "host-gone";
    }
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

type Send = (frame: Frame) => void;

export function wireFrames(
  socket: Duplex,
  receive: (frame: Frame) => void
): Send {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      if (newline > 32 * 1024 * 1024) return socket.destroy();
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        receive(JSON.parse(line) as Frame);
      } catch {
        return socket.destroy();
      }
    }
    if (pending.length > 32 * 1024 * 1024) socket.destroy();
  });
  return (frame) => {
    if (socket.destroyed || socket.writableLength > 32 * 1024 * 1024) {
      socket.destroy();
      throw new Error("Runner connection is unavailable");
    }
    socket.write(JSON.stringify(frame) + "\n");
  };
}

export function hostChannel(id: string, send: Send, dispose: () => void) {
  return new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      try {
        send({ type: "data", id, data: chunk.toString("base64") });
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    destroy(error, callback) {
      dispose();
      try {
        send({ type: "close", id });
      } catch {
        /* transport already closed */
      }
      callback(error);
    },
  });
}
