import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Frame, ChannelFrame } from "./index.js";

/** `flushed` runs once the frame has been handed to the transport, or with
 * an error if the transport closed first. */
type Send<T> = (frame: T, flushed?: (error?: Error | null) => void) => void;

export function wireFrames<Incoming = Frame, Outgoing = Frame>(
  socket: Duplex,
  receive: (frame: Incoming) => void,
  maxLineLength = 32 * 1024 * 1024
): Send<Outgoing> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      if (newline > maxLineLength) return socket.destroy();
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        receive(JSON.parse(line) as Incoming);
      } catch {
        return socket.destroy();
      }
    }
    if (pending.length > maxLineLength) socket.destroy();
  });
  return (frame, flushed) => {
    if (socket.destroyed || socket.writableLength > 32 * 1024 * 1024) {
      socket.destroy();
      throw new Error("Runner connection is unavailable");
    }
    const line = JSON.stringify(frame) + "\n";
    // Callers may pass `send` to forEach, which supplies an index.
    if (typeof flushed === "function") socket.write(line, flushed);
    else socket.write(line);
  };
}

export function hostChannel(
  id: string,
  send: Send<ChannelFrame>,
  dispose: () => void
) {
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
