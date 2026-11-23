/*
 * The local socket: an app's connection to the runner child it started. One
 * JSON value per line.
 *
 *   hello    The first line is `{nonce, streamCredit: true}` with the spawn's
 *            nonce. The runner answers `{type: "stream", action: "accept"}`;
 *            a wrong nonce closes the connection.
 *   call     `{id, op, input}` → `{id, ok: true, value}` or
 *            `{id, ok: false, error}`. `id` is scoped to the connection.
 *            A value too long for one line is answered `{id, ok: true,
 *            stream}` instead: its JSON text follows on the credit-controlled
 *            stream `reply:<id>`, which the caller registers on that answer.
 *   open     The same request for an `open` operation. A successful reply
 *            opens channel `id`: two credit-controlled streams,
 *            `channel:<id>:in` (to the runner) and `channel:<id>:out` (from
 *            it), each carrying the channel's bytes. On a typed channel each
 *            line is one message. Either side ending or failing closes both.
 *   stream   T10's credit frames (`v1/streams.ts`), shared with TLS.
 *   blob     `{type: "blob", id, path}`: the runner opens the existing
 *            regular file at `path` itself and feeds it to the blob it expects
 *            under `id`, answering `{type: "blob", id, ok, error?}`. A frame
 *            of this transport only: TLS sends a blob's bytes as a stream.
 *
 * A failure before the request is written is `unavailable` (not sent); a
 * connection lost after it is `unknown_outcome`.
 */
import { connect, type Socket } from "node:net";
import { Duplex, PassThrough, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  operations,
  runnerError,
  RunnerCallError,
  json,
  integer,
  literal,
  object,
  optional,
  string,
  union,
  type CallName,
  type ErrorCode,
  type Infer,
  type OpenName,
  type OperationSpec,
  type Req,
  type Res,
  type RunnerError,
} from "@dispatch/runner-protocol/contract";
import { FlowStreams, acceptsStreams } from "../v1/streams.js";
import { frameWriter } from "../v1/node.js";

export const socketHello = object({
  nonce: string,
  streamCredit: optional(literal(true)),
});
export const socketRequest = object({ id: integer, op: string, input: json });
export const socketReply = union(
  object({ id: integer, ok: literal(true), value: json }),
  object({ id: integer, ok: literal(true), stream: string }),
  object({ id: integer, ok: literal(false), error: runnerError })
);
/** The path-blob frame: accepted on the local socket only. */
export const blobPathFrame = object({
  type: literal("blob"),
  id: string,
  path: string,
});
export const blobPathReply = union(
  object({ type: literal("blob"), id: string, ok: literal(true) }),
  object({
    type: literal("blob"),
    id: string,
    ok: literal(false),
    error: runnerError,
  })
);
export type SocketRequest = Infer<typeof socketRequest>;
export type SocketReply = Infer<typeof socketReply>;
export type BlobPathFrame = Infer<typeof blobPathFrame>;
export type BlobPathReply = Infer<typeof blobPathReply>;

export type LocalEndpoint = { socket: string; nonce: string };

/** The stream that carries the JSON text of call `id`'s value. */
export function replyStream(id: number) {
  return `reply:${id}`;
}

/**
 * Values whose JSON text is longer than this go as a reply stream. Well
 * under a line's limit, so a reply never ends the connection.
 */
export const INLINE_REPLY_BYTES = 256 * 1024;

/** The two stream IDs that carry channel `id`. */
export function channelStreams(id: number) {
  return { in: `channel:${id}:in`, out: `channel:${id}:out` };
}

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DEADLINE_MS = 20_000;
const LONG_DEADLINE_MS = 300_000;

/** The reply deadline of a call: its contract class, or its own timeout plus 5 s. */
export function localDeadlineMs(spec: OperationSpec, input?: unknown): number {
  if (spec.timeout === "request") {
    const requested = (input as { timeoutMs?: unknown } | null)?.timeoutMs;
    if (typeof requested === "number") return requested + 5_000;
  }
  return spec.timeout === "long" ? LONG_DEADLINE_MS : DEFAULT_DEADLINE_MS;
}

/** Split a byte stream into JSON lines; a malformed line ends the stream. */
export function jsonLines(
  stream: NodeJS.ReadableStream & { destroy(): void },
  receive: (value: unknown) => void,
  maxLineLength = 1024 * 1024
) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        receive(JSON.parse(line));
      } catch {
        return stream.destroy();
      }
    }
    if (pending.length > maxLineLength) stream.destroy();
  });
}

const fail = (code: ErrorCode, message: string) =>
  new RunnerCallError({ code, message });

/**
 * Join a channel's two streams into the caller's duplex. Ending or destroying
 * either side closes the whole channel.
 */
export function channelDuplex(toPeer: PassThrough, fromPeer: PassThrough) {
  let waiting: (() => void) | undefined;
  const duplex = new Duplex({
    allowHalfOpen: false,
    read() {
      fromPeer.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (toPeer.destroyed) return callback(new Error("Channel closed"));
      if (toPeer.write(chunk)) return callback();
      waiting = () => {
        waiting = undefined;
        callback();
      };
      toPeer.once("drain", waiting);
    },
    final(callback) {
      toPeer.end();
      callback();
    },
    destroy(error, callback) {
      if (waiting) toPeer.off("drain", waiting);
      toPeer.destroy();
      fromPeer.destroy();
      callback(error);
    },
  });
  fromPeer.on("data", (chunk: Buffer) => {
    if (!duplex.push(chunk)) fromPeer.pause();
  });
  fromPeer.once("end", () => duplex.push(null));
  fromPeer.once("close", () => {
    if (!fromPeer.readableEnded) duplex.destroy();
  });
  toPeer.once("close", () => {
    if (!toPeer.writableFinished) duplex.destroy();
  });
  return duplex;
}

type Pending = {
  op: string;
  resolve(value: unknown): void;
  reject(error: RunnerCallError): void;
};

/**
 * One authenticated connection to a local runner. Calls and channels share
 * it; nothing reconnects here (see `session/`).
 */
export class LocalSocketConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly blobs = new Map<
    string,
    { resolve(): void; reject(error: RunnerCallError): void }
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly send: ReturnType<typeof frameWriter<unknown>>;
  readonly streams: FlowStreams;
  private open = true;

  private constructor(private readonly socket: Socket) {
    this.send = frameWriter<unknown>(socket);
    this.streams = new FlowStreams(socket, this.send);
    this.streams.enable();
    socket.once("close", () => {
      this.open = false;
      const lost = fail(
        "unknown_outcome",
        "The local runner connection closed before it answered"
      );
      for (const pending of this.pending.values()) pending.reject(lost);
      this.pending.clear();
      for (const blob of this.blobs.values()) blob.reject(lost);
      this.blobs.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  /** Connect and present the nonce. Rejects with `unavailable`. */
  static connect(
    endpoint: LocalEndpoint,
    timeoutMs = CONNECT_TIMEOUT_MS
  ): Promise<LocalSocketConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint.socket);
      let connection: LocalSocketConnection | undefined;
      const refuse = (message: string) => {
        clearTimeout(timer);
        socket.destroy();
        reject(fail("unavailable", message));
      };
      const timer = setTimeout(
        () => refuse("The local runner did not accept the connection"),
        timeoutMs
      );
      socket.on("error", () => {
        if (!connection) refuse("The local runner is unavailable");
      });
      socket.once("close", () => {
        if (!connection) refuse("The local runner refused the connection");
      });
      socket.once("connect", () => {
        socket.write(
          JSON.stringify({ nonce: endpoint.nonce, streamCredit: true }) + "\n"
        );
      });
      jsonLines(socket, (frame) => {
        if (connection) return connection.receive(frame);
        if (!acceptsStreams(frame))
          return refuse("The local runner sent no accept");
        clearTimeout(timer);
        connection = new LocalSocketConnection(socket);
        resolve(connection);
      });
    });
  }

  get connected(): boolean {
    return this.open && !this.socket.destroyed;
  }

  onClose(listener: () => void): () => void {
    if (!this.connected) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.destroy();
  }

  private receive(frame: unknown) {
    if (this.streams.handle(frame)) return;
    if (blobPathReply.check(frame)) {
      const blob = this.blobs.get(frame.id);
      this.blobs.delete(frame.id);
      if (frame.ok) blob?.resolve();
      else blob?.reject(new RunnerCallError(frame.error));
      return;
    }
    if (!socketReply.check(frame)) return this.socket.destroy();
    const pending = this.pending.get(frame.id);
    if (!pending) {
      // A streamed answer nobody waits for: refuse its stream.
      if (frame.ok && "stream" in frame)
        void this.streams
          .receive(frame.stream, new PassThrough().resume())
          .catch(() => {});
      return;
    }
    this.pending.delete(frame.id);
    if (!frame.ok) return pending.reject(new RunnerCallError(frame.error));
    if ("stream" in frame) {
      if (frame.stream !== replyStream(frame.id))
        return pending.reject(fail("failed", `Invalid ${pending.op} reply`));
      // Registered now, before the runner's first stream frame is read.
      const chunks: Buffer[] = [];
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer) => chunks.push(chunk));
      this.streams.receive(frame.stream, sink).then(
        () => {
          let value: unknown;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return pending.reject(
              fail("failed", `Invalid ${pending.op} reply`)
            );
          }
          this.settle(pending, value);
        },
        (error: unknown) =>
          pending.reject(
            error instanceof RunnerCallError
              ? new RunnerCallError({
                  code: "unknown_outcome",
                  message: `The ${pending.op} reply did not arrive: ${error.message}`,
                })
              : fail(
                  "unknown_outcome",
                  `The ${pending.op} reply did not arrive`
                )
          )
      );
      return;
    }
    this.settle(pending, frame.value);
  }

  private settle(pending: Pending, value: unknown) {
    const spec = (operations as Record<string, OperationSpec>)[pending.op];
    if (!spec?.response.check(value))
      return pending.reject(fail("failed", `Invalid ${pending.op} reply`));
    pending.resolve(value);
  }

  private request(
    op: string,
    input: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    before?: (id: number) => void
  ): { id: number; reply: Promise<unknown> } {
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      if (!this.connected)
        return reject(fail("unavailable", "The local runner is unavailable"));
      if (signal?.aborted)
        return reject(fail("cancelled", "The call was cancelled"));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done();
        reject(fail("timeout", `No ${op} reply in ${timeoutMs} ms`));
      }, timeoutMs);
      const abort = () => {
        this.pending.delete(id);
        done();
        reject(fail("cancelled", "The call was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        op,
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      try {
        before?.(id);
        this.send({ id, op, input });
      } catch {
        this.pending.delete(id);
        done();
        reject(fail("unavailable", "The local runner is unavailable"));
      }
    });
    return { id, reply };
  }

  call<K extends CallName>(
    op: K,
    input: Req<K>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<Res<K>> {
    const spec = operations[op] as OperationSpec;
    return this.request(
      op,
      input,
      opts.signal,
      opts.timeoutMs ?? localDeadlineMs(spec, input)
    ).reply as Promise<Res<K>>;
  }

  /** Open a channel. The duplex carries the channel's bytes. */
  async openChannel<K extends OpenName>(
    op: K,
    input: Req<K>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{ info: Res<K>; channel: Duplex }> {
    const spec = operations[op] as OperationSpec;
    const toRunner = new PassThrough();
    const fromRunner = new PassThrough();
    let ids: ReturnType<typeof channelStreams> | undefined;
    const { reply } = this.request(
      op,
      input,
      opts.signal,
      opts.timeoutMs ?? localDeadlineMs(spec),
      (id) => {
        // The runner may start sending as soon as it replies.
        ids = channelStreams(id);
        void this.streams
          .receive(ids.out, fromRunner, undefined, { stall: false })
          .catch(() => {});
      }
    );
    let info: unknown;
    try {
      info = await reply;
    } catch (error) {
      fromRunner.destroy();
      throw error;
    }
    void this.streams
      .send(ids!.in, toRunner, undefined, { stall: false })
      .catch(() => {});
    return {
      info: info as Res<K>,
      channel: channelDuplex(toRunner, fromRunner),
    };
  }

  /**
   * Hand the runner a blob it expects under `id`: as the path of an existing
   * file the runner opens itself (this transport only), or as bytes.
   */
  sendBlob(
    id: string,
    source: { path: string } | Readable,
    signal?: AbortSignal
  ): Promise<void> {
    if (!("path" in source) || typeof source.path !== "string")
      return this.streams.send(id, source as Readable, signal);
    const { path } = source;
    return new Promise((resolve, reject) => {
      if (!this.connected)
        return reject(fail("unavailable", "The local runner is unavailable"));
      if (this.blobs.has(id))
        return reject(fail("invalid", "That blob is already being sent"));
      this.blobs.set(id, { resolve, reject });
      try {
        this.send({ type: "blob", id, path } satisfies BlobPathFrame);
      } catch {
        this.blobs.delete(id);
        reject(fail("unavailable", "The local runner is unavailable"));
      }
    });
  }
}

/** One call over a fresh connection, closed afterwards. */
export async function callLocalSocket<K extends CallName>(
  socketPath: string,
  nonce: string,
  op: K,
  input: Req<K>,
  timeoutMs = 5_000
): Promise<Res<K>> {
  const connection = await LocalSocketConnection.connect(
    { socket: socketPath, nonce },
    timeoutMs
  );
  try {
    return await connection.call(op, input, { timeoutMs });
  } finally {
    connection.close();
  }
}

export type { RunnerError };
