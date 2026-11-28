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
 *   event    `{id, event}` before a call's answer: one event the operation
 *            declares (progress), in the order the runner reported them.
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
 *            With `inPlace: {mustExist}` the runner reads nothing: the call
 *            that expects the blob takes the path where it is (a missing
 *            file fails it when `mustExist`). Only a call that asked for a
 *            path in place accepts it, and it accepts nothing else.
 *
 * A failure before the request is written is `unavailable` (not sent); a
 * connection lost after it is `unknown_outcome`.
 */
import {
  MAX_SESSION_FILE_BYTES,
  MAX_CHECKOUT_VIEW_BYTES,
  MAX_CHECKOUT_COMMAND_FILE_BYTES,
  isCheckoutReadName,
} from "@dispatch/runner-protocol";
import { DEFAULT_REPLY_BYTES, ReceiveBuffer } from "./receive-buffer.js";
import { DIFF_IMAGE_MAX_BYTES } from "@dispatch/runner-protocol/diff-types";
import { CommandOutput } from "./command-output.js";
import { connect } from "node:net";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  operations,
  empty,
  runnerError,
  RunnerCallError,
  json,
  boolean,
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
  type OpName,
  type OperationSpec,
  type Req,
  type Res,
  type RunnerError,
} from "@dispatch/runner-protocol/contract";
import {
  parseUpdateStatus,
  type UpdateStatusFrame,
} from "@dispatch/runner-protocol";
import {
  CONNECTION_WINDOW,
  FlowStreams,
  acceptsStreams,
} from "../v1/streams.js";
import { frameWriter, wireFrames } from "../v1/node.js";

export const socketHello = object({
  nonce: string,
  streamCredit: optional(literal(true)),
});
/** Cancel an outstanding cancellable operation on the enrolled connection. */
export const socketCancel = object({ id: integer, cancel: literal(true) });
export const socketRequest = object({ id: integer, op: string, input: json });
export const socketReply = union(
  object({ id: integer, ok: literal(true), value: json }),
  object({
    id: integer,
    ok: literal(true),
    stream: string,
    workerReply: optional(literal(true)),
  }),
  object({ id: integer, ok: literal(false), error: runnerError })
);
/** An event of call `id`, sent before its answer. */
export const socketEvent = object({ id: integer, event: json });
/** The path-blob frame: accepted on the local socket only. */
export const blobPathFrame = object({
  type: literal("blob"),
  id: string,
  path: string,
  inPlace: optional(object({ mustExist: boolean })),
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
export type SocketEvent = Infer<typeof socketEvent>;
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

/** The credited file contents for a files.get request on an enrolled peer. */
export function downloadStream(id: number) {
  return `download:${id}`;
}

export function commandOutputStream(id: number, output: "stdout" | "stderr") {
  return `exec:${id}:${output}`;
}

/** The two stream IDs that carry channel `id`. */
export function channelStreams(id: number) {
  return { in: `channel:${id}:in`, out: `channel:${id}:out` };
}

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DEADLINE_MS = 20_000;
const LONG_DEADLINE_MS = 300_000;

/**
 * The reply deadline of a call: its contract class, or its own timeout plus
 * 5 s. A call whose request sets no timeout (`timeoutMs: null`) has none.
 */
export function localDeadlineMs(
  spec: OperationSpec,
  input?: unknown
): number | null {
  if (spec.timeout === "request") {
    const requested = (input as { timeoutMs?: unknown } | null)?.timeoutMs;
    if (typeof requested === "number") return requested + 5_000;
    if (requested === null) return null;
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
      if (newline > maxLineLength) return stream.destroy();
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

/** Repeatable mutations (for example session.stop) still have an uncertain outcome. */
const enrolledReads: ReadonlySet<OpName> = new Set<OpName>([
  "runner.describe",
  "runner.health",
  "session.attach",
  "session.alive",
  "session.logs",
  "session.list",
  "session.sample",
  "workspace.describe",
  "workspace.observe",
  "path.resolve",
  "path.complete",
  "checkout.list",
  "checkout.access",
  "checkout.read",
  "checkout.preview",
  "checkout.index",
  "checkout.stats",
  "checkout.diff",
  "checkout.image",
  "checkout.changes",
  "checkout.defaultFiles",
  "checkout.watch",
  "files.get",
  "git.roots",
  "git.origin",
  "git.context",
  "git.defaultBranch",
  "git.remoteHeads",
  "git.branches",
  "git.base",
  "github.account",
  "github.repositories",
  "github.branches",
  "github.pr.head",
  "github.pr.status",
  "github.pr.details",
  "github.pr.diff",
  "engine.list",
  "engine.update.inspect",
  "engine.update.probe",
  "engine.operation",
  "engine.login.status",
  "engine.models",
  "engine.usage",
  "engine.plugin.status",
]);

/** Budgets count the encoded JSON, including escaped text and worker metadata. */
function enrolledReplyBudget(op: string, input: unknown) {
  const metadata = 16 * 1024;
  const spec = (operations as Record<string, OperationSpec>)[op];
  if (
    spec?.response === empty ||
    spec?.response === boolean ||
    op === "session.alive"
  )
    return metadata;
  if (op === "checkout.read") {
    const read = input as Req<"checkout.read">;
    const max =
      read.mode === "command-manifest"
        ? Math.min(read.maxBytes ?? Infinity, MAX_CHECKOUT_COMMAND_FILE_BYTES)
        : read.maxBytes;
    if (max !== null && max >= 0)
      return (
        metadata +
        (read.encoding === "base64" ? 4 * Math.ceil(max / 3) : 6 * max)
      );
  }
  if (op === "checkout.exec") {
    const { maxOutput } = input as Req<"checkout.exec">;
    if (maxOutput !== null && maxOutput >= 0) return metadata + 12 * maxOutput;
  }
  if (op === "checkout.image")
    return metadata + 4 * Math.ceil(DIFF_IMAGE_MAX_BYTES / 3);
  if (
    [
      "checkout.list",
      "checkout.preview",
      "checkout.index",
      "checkout.stats",
      "checkout.diff",
    ].includes(op)
  )
    return MAX_CHECKOUT_VIEW_BYTES + metadata;
  if (op === "files.get") return metadata;
  return DEFAULT_REPLY_BYTES;
}

type Pending = {
  op: string;
  budget: number;
  onEvent?: (event: unknown) => void;
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

  private constructor(
    private readonly socket: Duplex,
    private readonly enrolled?: {
      onUpdateStatus?: (frame: UpdateStatusFrame) => void;
    }
  ) {
    this.send = frameWriter<unknown>(socket);
    this.streams = new FlowStreams(
      socket,
      this.send,
      undefined,
      enrolled ? CONNECTION_WINDOW : undefined
    );
    this.streams.enable();
    socket.once("close", () => {
      this.open = false;
      const lost = fail(
        "unknown_outcome",
        "The local runner connection closed before it answered"
      );
      for (const pending of this.pending.values())
        pending.reject(this.lostReply(pending, lost));
      this.pending.clear();
      for (const blob of this.blobs.values()) blob.reject(lost);
      this.blobs.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  private lostReply(pending: Pending, error: RunnerCallError) {
    return this.enrolled && enrolledReads.has(pending.op as OpName)
      ? fail("unavailable", "The runner connection closed before it answered")
      : error;
  }

  /** The TLS service has already authenticated this connection. */
  static fromAuthenticatedSocket(
    socket: Duplex,
    onUpdateStatus?: (frame: UpdateStatusFrame) => void
  ) {
    const connection = new LocalSocketConnection(socket, { onUpdateStatus });
    wireFrames<unknown>(socket, (frame) => connection.receive(frame));
    return connection;
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
    if (
      this.enrolled &&
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === "update_status"
    ) {
      const status = parseUpdateStatus(frame);
      if (!status) return this.socket.destroy();
      this.enrolled.onUpdateStatus?.(status);
      return;
    }
    if (this.streams.handle(frame)) return;
    if (blobPathReply.check(frame)) {
      const blob = this.blobs.get(frame.id);
      this.blobs.delete(frame.id);
      if (frame.ok) blob?.resolve();
      else blob?.reject(new RunnerCallError(frame.error));
      return;
    }
    if (socketEvent.check(frame)) {
      const pending = this.pending.get(frame.id);
      const spec = pending
        ? (operations as Record<string, OperationSpec>)[pending.op]
        : undefined;
      // An event nobody waits for, or one the operation does not declare, is dropped.
      if (pending?.onEvent && spec?.events?.check(frame.event))
        pending.onEvent(frame.event);
      return;
    }
    if (!socketReply.check(frame)) return this.socket.destroy();
    const pending = this.pending.get(frame.id);
    // Without a registered receiver FlowStreams refuses the peer's open.
    if (!pending) return;
    this.pending.delete(frame.id);
    if (!frame.ok) return pending.reject(new RunnerCallError(frame.error));
    if ("stream" in frame) {
      if (frame.stream !== replyStream(frame.id))
        return pending.reject(fail("failed", `Invalid ${pending.op} reply`));
      // Registered now, before the runner's first stream frame is read.
      const bytes = new ReceiveBuffer(pending.budget);
      const sink = new Writable({
        write(chunk: Buffer, _, done) {
          if (bytes.append(chunk)) return done();
          pending.reject(
            fail("too_large", `The ${pending.op} reply exceeds its byte limit`)
          );
          done(new Error("Reply exceeds its byte limit"));
        },
      });
      this.streams.receive(frame.stream, sink).then(
        () => {
          let value: unknown;
          try {
            value = JSON.parse(bytes.bytes().toString("utf8"));
          } catch {
            return pending.reject(
              fail("failed", `Invalid ${pending.op} reply`)
            );
          }
          if (this.enrolled && frame.workerReply) {
            if (!value || typeof value !== "object")
              return pending.reject(
                fail("failed", `Invalid ${pending.op} reply`)
              );
            if ("error" in value && runnerError.check(value.error))
              return pending.reject(new RunnerCallError(value.error));
            value = "data" in value ? value.data : undefined;
          }
          this.settle(pending, value);
        },
        (error: unknown) => {
          // A worker or transfer can fail while the enrolled connection is
          // healthy. Preserve that read failure instead of reporting a redial.
          if (
            this.enrolled &&
            enrolledReads.has(pending.op as OpName) &&
            this.connected &&
            error instanceof RunnerCallError &&
            error.code !== "unavailable"
          )
            return pending.reject(error);
          pending.reject(
            this.lostReply(
              pending,
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
        }
      );
      return;
    }
    this.settle(pending, frame.value);
  }

  private settle(pending: Pending, value: unknown) {
    const spec = (operations as Record<string, OperationSpec>)[pending.op];
    if (!spec?.response.check(value)) {
      if (
        this.enrolled &&
        (pending.op === "engine.list" || pending.op === "runner.health")
      )
        this.socket.destroy();
      return pending.reject(fail("failed", `Invalid ${pending.op} reply`));
    }
    pending.resolve(value);
  }

  private request(
    op: string,
    input: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number | null,
    before?: (id: number) => void,
    onEvent?: (event: unknown) => void
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
      const cancelRemote = () => {
        this.streams.interrupt(replyStream(id), "cancelled");
        const spec = (operations as Record<string, OperationSpec>)[op];
        if (
          !this.enrolled ||
          !(
            spec?.cancellable ||
            spec?.kind === "open" ||
            isCheckoutReadName(op)
          )
        )
          return;
        try {
          this.send({ id, cancel: true });
        } catch {
          // Connection close already cancels this runner's checkout commands.
        }
      };
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              cancelRemote();
              this.pending.delete(id);
              done();
              reject(fail("timeout", `No ${op} reply in ${timeoutMs} ms`));
            }, timeoutMs);
      const abort = () => {
        cancelRemote();
        this.pending.delete(id);
        done();
        reject(fail("cancelled", "The call was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        op,
        budget: this.enrolled ? enrolledReplyBudget(op, input) : Infinity,
        onEvent,
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
    opts: {
      signal?: AbortSignal;
      /** The reply deadline; null waits without one. Default: the operation's class. */
      timeoutMs?: number | null;
      onEvent?: (event: unknown) => void;
    } = {}
  ): Promise<Res<K>> {
    const spec = operations[op] as OperationSpec;
    if (this.enrolled && op === "checkout.exec") {
      return this.exec(
        input as Req<"checkout.exec">,
        opts.signal,
        opts.timeoutMs
      ) as Promise<Res<K>>;
    }
    return this.request(
      op,
      input,
      opts.signal,
      opts.timeoutMs === undefined
        ? localDeadlineMs(spec, input)
        : opts.timeoutMs,
      undefined,
      opts.onEvent
    ).reply as Promise<Res<K>>;
  }

  private async exec(
    input: Req<"checkout.exec">,
    signal: AbortSignal | undefined,
    timeoutMs?: number | null
  ): Promise<Res<"checkout.exec">> {
    const cleanup = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, cleanup.signal])
      : cleanup.signal;
    const bytes = {
      stdout: new CommandOutput(input.maxOutput),
      stderr: new CommandOutput(input.maxOutput),
    };
    let overflow = false;
    let transfers: Promise<void[]> | undefined;
    const { id, reply } = this.request(
      "checkout.exec",
      input,
      active,
      timeoutMs === undefined
        ? localDeadlineMs(operations["checkout.exec"], input)
        : timeoutMs,
      (id) => {
        transfers = Promise.all(
          (["stdout", "stderr"] as const).map((name) =>
            this.streams.receive(
              commandOutputStream(id, name),
              new Writable({
                write(chunk: Buffer, _, done) {
                  if (bytes[name].write(chunk)) return done();
                  overflow = true;
                  cleanup.abort();
                  done(new Error("Command output exceeds its byte limit"));
                },
              }),
              active,
              { stall: false }
            )
          )
        );
        // The reply distinguishes a refused command from lost acknowledgement.
        void transfers.catch(() => {});
      }
    );
    try {
      const result = await reply;
      if (!operations["checkout.exec"].response.check(result))
        throw fail("invalid", "Invalid checkout command status.");
      // A handler that returned the strings directly uses the ordinary reply.
      // Streamed output is complete before the runner acknowledges its status.
      if (!transfers || (!bytes.stdout.received && !bytes.stderr.received))
        return result;
      if (
        this.streams.has(commandOutputStream(id, "stdout")) ||
        this.streams.has(commandOutputStream(id, "stderr"))
      )
        throw fail("invalid", "Runner acknowledged unfinished command output.");
      await transfers;
      const out = bytes.stdout.finish();
      const err = bytes.stderr.finish();
      return {
        ...result,
        stdout: out.text,
        stderr: err.text,
        ...(input.maxOutput !== null && {
          truncated: Boolean(
            result.truncated || out.truncated || err.truncated
          ),
        }),
      };
    } catch (error) {
      if (overflow)
        throw fail("too_large", "Command output exceeds its byte limit");
      throw error;
    } finally {
      cleanup.abort();
    }
  }

  async collectFile(input: Req<"files.get">): Promise<Buffer> {
    const bytes = new ReceiveBuffer(MAX_SESSION_FILE_BYTES);
    let overflow = false;
    try {
      await this.getFile(
        input,
        new Writable({
          write(chunk: Buffer, _, done) {
            if (bytes.append(chunk)) return done();
            overflow = true;
            done(new Error("Session files are limited to 20 MiB."));
          },
        })
      );
    } catch (error) {
      if (overflow)
        throw fail("too_large", "Session files are limited to 20 MiB.");
      throw error;
    }
    return bytes.bytes();
  }

  async putFile(input: Req<"files.put">, source: () => Readable) {
    if (!this.connected)
      throw fail("unavailable", "The runner connection is closed");
    const stream = source();
    const controller = new AbortController();
    const reply = this.call("files.put", input, {
      timeoutMs: null,
      signal: controller.signal,
    });
    try {
      const transfer = this.sendBlob(
        input.blob,
        stream,
        controller.signal
      ).catch(async (error: unknown) => {
        if (
          !this.connected &&
          error instanceof RunnerCallError &&
          error.code === "unavailable"
        ) {
          // The request tracks whether it was written and owns the mutation outcome.
          await reply;
          throw fail(
            "unknown_outcome",
            "The runner closed before acknowledging the upload"
          );
        }
        throw error;
      });
      const [result] = await Promise.all([reply, transfer]);
      return result;
    } finally {
      void reply.catch(() => {});
      controller.abort();
    }
  }

  /** Register the download sink before the runner can send any file bytes. */
  async getFile(
    input: Req<"files.get">,
    sink: Writable,
    signal?: AbortSignal
  ): Promise<Res<"files.get">> {
    if (!this.enrolled)
      throw fail("invalid", "File downloads require an enrolled connection");
    const controller = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let transfer: Promise<void> | undefined;
    const { id, reply } = this.request(
      "files.get",
      input,
      active,
      null,
      (id) => {
        transfer = this.streams.receive(downloadStream(id), sink, active);
      }
    );
    try {
      const [value] = await Promise.all([reply, transfer]);
      if (
        !operations["files.get"].response.check(value) ||
        value.blob !== downloadStream(id)
      )
        throw fail("invalid", "Invalid runner file response.");
      return value;
    } finally {
      controller.abort();
    }
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
    source: { path: string; inPlace?: { mustExist: boolean } } | Readable,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      (this.enrolled && source instanceof Readable) ||
      !("path" in source) ||
      typeof source.path !== "string"
    )
      return this.streams.send(id, source as Readable, signal);
    if (this.enrolled)
      return Promise.reject(
        fail("invalid", "A blob path requires a local socket")
      );
    const { path, inPlace } = source as {
      path: string;
      inPlace?: { mustExist: boolean };
    };
    return new Promise((resolve, reject) => {
      if (!this.connected)
        return reject(fail("unavailable", "The local runner is unavailable"));
      if (this.blobs.has(id))
        return reject(fail("invalid", "That blob is already being sent"));
      this.blobs.set(id, { resolve, reject });
      try {
        this.send({
          type: "blob",
          id,
          path,
          ...(inPlace && { inPlace: { mustExist: inPlace.mustExist } }),
        } satisfies BlobPathFrame);
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
