import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Frame } from "./index.js";

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
