/*
 * Wire v1 host frames behind the `session.attach` channel. A v1 host names
 * its agent in `welcome`, in every journaled event and in MCP inventory
 * results; the contract channel is the session, so decoding drops that id
 * and encoding restores it. Client frames are the same on both sides.
 */
import { StringDecoder } from "node:string_decoder";
import { Duplex } from "node:stream";
import type {
  Infer,
  clientMessage,
  hostMessage,
} from "@dispatch/runner-protocol/contract";

export type ClientMessage = Infer<typeof clientMessage>;
export type HostMessage = Infer<typeof hostMessage>;

type AnyRecord = Record<string, unknown>;

const withoutAgent = ({ agentId: _, ...rest }: AnyRecord) => rest;

/** A v1 host frame as the contract message. */
export function decodeHostFrame(frame: AnyRecord): HostMessage {
  switch (frame.type) {
    case "welcome":
      return withoutAgent(frame) as HostMessage;
    case "event":
      return {
        ...frame,
        event: withoutAgent(frame.event as AnyRecord),
      } as HostMessage;
    case "mcp_inventory_result":
      return {
        ...frame,
        result: withoutAgent(frame.result as AnyRecord),
      } as HostMessage;
    default:
      return frame as HostMessage;
  }
}

/** A contract message as the v1 host frame for the session's agent. */
export function encodeHostFrame(
  message: HostMessage,
  agentId: string
): AnyRecord {
  switch (message.type) {
    case "welcome":
      return { ...message, agentId };
    case "event": {
      // v1 hosts write the agent id right after the event type.
      const { type, ...event } = message.event;
      return { ...message, event: { type, agentId, ...event } };
    }
    case "mcp_inventory_result":
      return { ...message, result: { agentId, ...message.result } };
    default:
      return message;
  }
}

/**
 * A v1 host frame for the session `agentId` as the contract message, or the
 * error the caller sees instead. Decoding drops the agent id, so a result a
 * v1 host gave for another agent is refused here, where the id is still
 * known: an MCP inventory answer becomes an error for its request.
 */
export function decodeSessionFrame(
  frame: AnyRecord,
  agentId: string
): HostMessage {
  if (
    frame.type === "mcp_inventory_result" &&
    (frame.result as AnyRecord | undefined)?.agentId !== agentId
  )
    return {
      type: "error",
      id: frame.id,
      message: "The host answered for another session.",
    } as HostMessage;
  return decodeHostFrame(frame);
}

/**
 * Newline-delimited JSON frames as the v1 host and its clients write them:
 * Blank and malformed lines are skipped. The enrolled carrier supplies its byte limit.
 */
export function frameDecoder(
  maxLineBytes = Infinity
): (chunk: Buffer | string) => AnyRecord[] {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let lineBytes = 0;
  return (chunk) => {
    if (Number.isFinite(maxLineBytes)) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let start = 0;
      while (start < bytes.length) {
        const end = bytes.indexOf(10, start);
        lineBytes += (end < 0 ? bytes.length : end) - start;
        if (lineBytes > maxLineBytes)
          throw new Error("Host frame exceeds its byte limit");
        if (end < 0) break;
        lineBytes = 0;
        start = end + 1;
      }
    }
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const frames: AnyRecord[] = [];
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object") frames.push(value as AnyRecord);
      } catch {
        // Skipped, as the v1 client skips it.
      }
    }
    return frames;
  };
}

/**
 * A duplex over `source` whose incoming frames pass through `map`; outgoing
 * bytes go to `source` unchanged (client frames are the same on both sides).
 * Either end closing closes the other, and a slow reader pauses `source`.
 */
export function mapIncomingFrames(
  source: Duplex,
  map: (frame: AnyRecord) => unknown,
  maxLineBytes?: number
): Duplex {
  const decode = frameDecoder(maxLineBytes);
  const mapped: Duplex = new Duplex({
    allowHalfOpen: false,
    read() {
      source.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (source.destroyed) return callback(new Error("Channel closed"));
      source.write(chunk, (error) => callback(error ?? null));
    },
    final(callback) {
      source.end();
      callback();
    },
    destroy(error, callback) {
      source.destroy();
      callback(error);
    },
  });
  source.on("data", (chunk: Buffer) => {
    let frames: AnyRecord[];
    try {
      frames = decode(chunk);
    } catch {
      mapped.destroy();
      return;
    }
    for (const frame of frames) {
      if (mapped.destroyed) return;
      if (!mapped.push(JSON.stringify(map(frame)) + "\n")) source.pause();
    }
  });
  source.once("end", () => mapped.push(null));
  source.once("close", () => mapped.destroy());
  source.on("error", () => mapped.destroy());
  return mapped;
}
