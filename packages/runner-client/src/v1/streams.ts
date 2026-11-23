import { once } from "node:events";
import type { Duplex, Readable, Writable } from "node:stream";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";

export const STREAM_WINDOW = 256 * 1024;
export const STREAM_CHUNK = 32 * 1024;
// Count small frames against credit too, bounding the number of queued writes
// when the sender emits very short records.
const MIN_FRAME_CREDIT = 1024;
const STALL_TIMEOUT = 30_000;

type Failure = "cancelled" | "timeout" | "invalid" | "failed" | "unavailable";
type Part =
  | { action: "open" | "end" | "done" }
  | { action: "credit"; bytes: number }
  | { action: "chunk"; data: string }
  | { action: "cancel"; code: Failure };

export type StreamFrame =
  | { type: "stream"; action: "accept" }
  | ({ type: "stream"; id: string } & Part);

interface Transfer {
  id: string;
  io: Readable | Writable;
  credit: number;
  phase: "waiting" | "open" | "ended";
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
  cancelWrite?: () => void;
  finish(error?: RunnerCallError): void;
}

type Sender = Transfer & { direction: "send"; io: Readable };
type Receiver = Transfer & { direction: "receive"; io: Writable };
type Active = Sender | Receiver;

function streamError(code: Failure, message: string) {
  return new RunnerCallError({ code, message });
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256;
}

function cancelCode(code: unknown): Failure {
  switch (code) {
    case "timeout":
    case "invalid":
    case "failed":
    case "unavailable":
      return code;
    default:
      return "cancelled";
  }
}

/**
 * Per-connection byte streams. Register the sink before asking the peer to
 * send, using a fresh connection-scoped ID. The operation carrying that ID
 * owns authorization and interpretation (raw bytes, NDJSON, or a blob).
 * The sender resolves only after the sink has finished. Each endpoint owns
 * its stream after registration and destroys it on failure or abort.
 */
export class FlowStreams {
  private readonly active = new Map<string, Active>();
  private readonly queued = new Map<Sender, () => void>();
  private writing = false;
  private enabled = false;

  constructor(
    private readonly socket: Duplex,
    private readonly write: (
      frame: StreamFrame,
      flushed?: (error?: Error | null) => void
    ) => void,
    private readonly stallMs = STALL_TIMEOUT
  ) {
    socket.once("close", () => {
      for (const entry of this.active.values()) {
        entry.finish(streamError("unavailable", "Stream connection closed"));
      }
    });
  }

  /** Call only after the transport's capability handshake. */
  enable() {
    this.enabled = true;
  }

  /** Send a blob or stream. The source should produce bounded chunks. */
  send(id: string, io: Readable, signal?: AbortSignal): Promise<void> {
    return this.start({ id, io, direction: "send" }, signal);
  }

  /** Receive into a backpressure-aware sink. Credit returns on write callbacks. */
  receive(id: string, io: Writable, signal?: AbortSignal): Promise<void> {
    return this.start({ id, io, direction: "receive" }, signal);
  }

  private start(
    input: { id: string } & (
      | { direction: "send"; io: Readable }
      | { direction: "receive"; io: Writable }
    ),
    signal?: AbortSignal
  ): Promise<void> {
    const { id, io } = input;
    if (!this.enabled || this.socket.destroyed)
      return Promise.reject(
        streamError("unavailable", "Stream capability unavailable")
      );
    if (!validId(id) || this.active.has(id))
      return Promise.reject(
        streamError("invalid", "Invalid or active stream ID")
      );

    return new Promise((resolve, reject) => {
      const fail = () => this.cancel(entry, "failed", "Stream I/O failed");
      const abort = () => this.cancel(entry, "cancelled", "Stream cancelled");
      const close = () => {
        const ended =
          input.direction === "send"
            ? input.io.readableEnded
            : input.io.writableFinished;
        if (!ended) fail();
      };
      const entry: Active = {
        ...input,
        credit: 0,
        phase: "waiting",
        finish: (error) => {
          if (!this.active.delete(id)) return;
          clearTimeout(entry.timer);
          entry.wake?.();
          entry.cancelWrite?.();
          signal?.removeEventListener("abort", abort);
          io.off("close", close);
          // An in-flight write can report its error during destruction.
          if (error && !io.closed) {
            io.once("close", () => io.off("error", fail));
            io.destroy();
          } else {
            io.off("error", fail);
          }
          if (error) reject(error);
          else resolve();
        },
      };
      this.active.set(id, entry);
      io.on("error", fail);
      io.once("close", close);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.touch(entry);
      if (entry.direction === "send") {
        if (!this.reply(entry, { action: "open" })) return;
        void this.pump(entry).catch(() => fail());
      }
    });
  }

  private touch(entry: Active) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.cancel(entry, "timeout", "Stream made no progress"),
      this.stallMs
    );
    entry.timer.unref();
  }

  private cancel(entry: Active, code: Failure, message: string) {
    if (this.active.get(entry.id) !== entry) return;
    entry.finish(streamError(code, message));
    this.rejectPeer(entry.id, code);
  }

  private rejectPeer(id: string, code: Failure) {
    try {
      this.write({ type: "stream", id, action: "cancel", code });
    } catch {
      // The connection is already closing.
    }
  }

  private reply(entry: Active, part: Part) {
    try {
      this.write({ type: "stream", id: entry.id, ...part });
      return true;
    } catch {
      entry.finish(streamError("unavailable", "Could not send stream frame"));
      return false;
    }
  }

  private async waitCredit(entry: Sender) {
    while (
      entry.credit < MIN_FRAME_CREDIT &&
      this.active.get(entry.id) === entry
    ) {
      await new Promise<void>((resolve) => {
        entry.wake = resolve;
      });
      entry.wake = undefined;
    }
    return this.active.get(entry.id) === entry;
  }

  private async pump(entry: Sender) {
    if (!(await this.waitCredit(entry))) return;
    for await (const bytes of entry.io) {
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected bytes");
      for (let offset = 0; offset < bytes.length; ) {
        if (!(await this.waitCredit(entry))) return;
        const slice = bytes.subarray(
          offset,
          offset + Math.min(STREAM_CHUNK, entry.credit)
        );
        entry.credit -= Math.max(slice.length, MIN_FRAME_CREDIT);
        offset += slice.length;
        await this.sendChunk(entry, slice);
      }
      // Do not pull another source chunk while the window is exhausted.
      if (!(await this.waitCredit(entry))) return;
    }
    if (this.active.get(entry.id) !== entry) return;
    entry.phase = "ended";
    this.touch(entry);
    this.reply(entry, { action: "end" });
  }

  private sendChunk(entry: Sender, bytes: Uint8Array) {
    return new Promise<void>((resolve, reject) => {
      entry.cancelWrite = () => {
        this.queued.delete(entry);
        resolve();
      };
      this.queued.set(entry, () => {
        this.writing = true;
        void this.flushChunk(entry, bytes)
          .finally(() => {
            entry.cancelWrite = undefined;
            this.writing = false;
            this.flushNext();
          })
          .then(resolve, reject);
      });
      this.flushNext();
    });
  }

  private flushNext() {
    if (this.writing) return;
    const next = this.queued.entries().next();
    if (next.done) return;
    const [entry, write] = next.value;
    this.queued.delete(entry);
    write();
  }

  private async flushChunk(entry: Sender, bytes: Uint8Array) {
    // A stalled reader has no credit and never occupies this queue. At most
    // one stream data write enters the socket at a time; legacy writes bypass
    // the queue. Recheck drain because legacy writes can refill it meanwhile.
    while (!this.socket.destroyed && this.socket.writableNeedDrain) {
      await once(this.socket, "drain", {
        signal: AbortSignal.timeout(this.stallMs),
      });
      if (this.active.get(entry.id) !== entry) return;
    }
    if (this.active.get(entry.id) !== entry || this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      this.write(
        {
          type: "stream",
          id: entry.id,
          action: "chunk",
          data: Buffer.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).toString("base64"),
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }

  /** Returns false for legacy frames and for extensions before negotiation. */
  handle(value: unknown): boolean {
    if (!this.enabled || !value || typeof value !== "object") return false;
    const frame = value as Record<string, unknown>;
    if (frame.type !== "stream") return false;
    const { id, action } = frame;
    if (!validId(id)) return true;
    const entry = this.active.get(id);
    if (!entry) {
      if (action === "open") this.rejectPeer(id, "invalid");
      return true;
    }
    if (action === "cancel") {
      entry.finish(
        streamError(cancelCode(frame.code), "Peer ended the stream")
      );
    } else if (entry.direction === "send") {
      this.handleSender(entry, action, frame.bytes);
    } else {
      try {
        this.handleReceiver(entry, action, frame.data);
      } catch {
        this.cancel(entry, "failed", "Stream sink failed");
      }
    }
    return true;
  }

  private handleSender(entry: Sender, action: unknown, bytes: unknown) {
    if (action === "done" && entry.phase === "ended") {
      entry.finish();
      return;
    }
    if (
      action === "credit" &&
      typeof bytes === "number" &&
      Number.isInteger(bytes) &&
      bytes > 0 &&
      bytes <= STREAM_WINDOW - entry.credit &&
      (entry.phase !== "waiting" || bytes === STREAM_WINDOW)
    ) {
      entry.credit += bytes;
      if (entry.phase === "waiting") entry.phase = "open";
      this.touch(entry);
      entry.wake?.();
      return;
    }
    this.cancel(entry, "invalid", "Invalid frame for sending stream");
  }

  private handleReceiver(entry: Receiver, action: unknown, data: unknown) {
    if (action === "open" && entry.phase === "waiting") {
      entry.phase = "open";
      entry.credit = STREAM_WINDOW;
      this.touch(entry);
      this.reply(entry, { action: "credit", bytes: STREAM_WINDOW });
      return;
    }
    if (action === "end" && entry.phase === "open") {
      entry.phase = "ended";
      this.touch(entry);
      entry.io.end((error?: Error | null) => {
        if (this.active.get(entry.id) !== entry) return;
        if (error) this.cancel(entry, "failed", "Stream sink could not finish");
        else if (this.reply(entry, { action: "done" })) entry.finish();
      });
      return;
    }
    if (
      action === "chunk" &&
      entry.phase === "open" &&
      typeof data === "string" &&
      data.length <= Math.ceil(STREAM_CHUNK / 3) * 4
    ) {
      const bytes = Buffer.from(data, "base64");
      const cost = Math.max(bytes.length, MIN_FRAME_CREDIT);
      if (
        bytes.length > 0 &&
        bytes.length <= STREAM_CHUNK &&
        cost <= entry.credit &&
        bytes.toString("base64") === data
      ) {
        entry.credit -= cost;
        entry.io.write(bytes, (error) => {
          if (this.active.get(entry.id) !== entry) return;
          if (error) {
            this.cancel(entry, "failed", "Stream sink write failed");
            return;
          }
          this.touch(entry);
          if (entry.phase !== "open") return;
          entry.credit += cost;
          this.reply(entry, { action: "credit", bytes: cost });
        });
        return;
      }
    }
    this.cancel(entry, "invalid", "Invalid frame for receiving stream");
  }
}

export function acceptsStreams(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return frame.type === "stream" && frame.action === "accept";
}
