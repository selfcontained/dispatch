import { chmodSync, createReadStream, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { Readable, type Duplex, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  operations,
  type CallName,
  type ErrorCode,
  type Json,
  type OpenName,
  type OperationSpec,
  type Req,
  type Res,
  type RunnerError,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import {
  blobPathFrame,
  channelStreams,
  INLINE_REPLY_BYTES,
  jsonLines,
  replyStream,
  socketHello,
  socketRequest,
  type BlobPathReply,
  type SocketEvent,
  type SocketReply,
} from "@dispatch/runner-client/transport/local-socket";
import {
  FlowStreams,
  frameWriter,
  type StreamFrame,
} from "@dispatch/runner-client/v1/node";
import { fencedError, type WriteFence } from "./fence.js";

/** What a handler may use of the connection its request arrived on. */
export type ConnectionContext = {
  /**
   * Expect a blob under `id` and write it into `sink`. The caller sends it as
   * bytes or, on this socket, as a file path. Register before the handler's
   * first `await`: frames after the request may already carry it.
   */
  receiveBlob(id: string, sink: Writable): Promise<void>;
  /**
   * Expect a blob under `id` as the path of a file on this machine, taken
   * where it is: nothing is read. Only this socket's path frame marked
   * `inPlace` satisfies it, and a plain blob refuses such a frame. Register
   * before the handler's first `await`. Absent where a transport cannot
   * hand a path over in place.
   */
  receiveBlobPath?(id: string): Promise<InPlaceBlob>;
  /**
   * Report one event of this call (an operation's declared `events`) before
   * its answer. An event the operation does not declare is dropped.
   */
  emit(event: unknown): void;
};

export type CallHandlers = Partial<{
  [K in CallName]: (
    input: Req<K>,
    context: ConnectionContext
  ) => Promise<Res<K>> | Res<K>;
}>;

/** An `open` handler returns its info and the runner's end of the channel. */
export type OpenHandlers = Partial<{
  [K in OpenName]: (
    input: Req<K>,
    context: ConnectionContext
  ) => Promise<{ info: Res<K>; channel: Duplex }>;
}>;

export type Handlers = { calls: CallHandlers; opens?: OpenHandlers };

/** A file handed over where it is (`receiveBlobPath`). */
export type InPlaceBlob = { path: string; mustExist: boolean };

type Expected =
  | { sink: Writable; resolve(): void; reject(error: unknown): void }
  | { take(blob: InPlaceBlob): void; reject(error: unknown): void };

const fileErrors: Record<string, ErrorCode> = {
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  EACCES: "forbidden",
  EPERM: "forbidden",
};

function errorOf(error: unknown): RunnerError {
  if (error instanceof RunnerCallError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
    };
  return {
    code: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The child's socket (protocol in `transport/local-socket.ts`). Each
 * connection must open with the spawn's nonce; any other first line closes
 * it. Operations without a handler answer `unsupported`. With a `fence`,
 * admission refuses writes with `fenced` while it is frozen, before any
 * handler runs, and counts admitted writes until they finish.
 */
export async function serveSocket(
  path: string,
  nonce: string,
  handlers: CallHandlers | Handlers,
  fence?: WriteFence
): Promise<{ close(): void }> {
  const { calls, opens = {} } =
    "calls" in handlers ? (handlers as Handlers) : { calls: handlers };
  rmSync(path, { force: true }); // Safe: the state lock is held.
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    let trusted = false;
    const send = frameWriter<
      StreamFrame | SocketReply | SocketEvent | BlobPathReply
    >(socket);
    const write = (frame: SocketReply | SocketEvent | BlobPathReply) => {
      if (socket.destroyed) return;
      try {
        send(frame);
      } catch {
        // The connection is closing.
      }
    };
    const streams = new FlowStreams(socket, send);
    const expected = new Map<string, Expected>();
    socket.once("close", () => {
      for (const blob of expected.values())
        blob.reject(new Error("Connection closed"));
      expected.clear();
    });
    const context: Omit<ConnectionContext, "emit"> = {
      receiveBlob(id, sink) {
        return new Promise((resolve, reject) => {
          if (expected.has(id) || streams.has(id))
            return reject(new Error("Blob ID already in use"));
          expected.set(id, { sink, resolve, reject });
        });
      },
      receiveBlobPath(id) {
        return new Promise((take, reject) => {
          if (expected.has(id) || streams.has(id))
            return reject(new Error("Blob ID already in use"));
          expected.set(id, { take, reject });
        });
      },
    };

    const refuseBlob = (id: string, message: string) => {
      const failure = { code: "invalid" as const, message };
      const blob = expected.get(id);
      if (blob) {
        expected.delete(id);
        blob.reject(new RunnerCallError(failure));
      }
      write({ type: "blob", id, ok: false, error: failure });
    };

    /** A file handed over where it is: nothing is read or checked here. */
    const takePathBlob = (id: string, file: string, mustExist: boolean) => {
      const blob = expected.get(id);
      if (!blob || !("take" in blob))
        return refuseBlob(id, "No blob is expected in place under it");
      if (!isAbsolute(file))
        return refuseBlob(id, "A blob path must be absolute");
      expected.delete(id);
      blob.take({ path: file, mustExist });
      write({ type: "blob", id, ok: true });
    };

    const readPathBlob = async (id: string, file: string) => {
      const blob = expected.get(id);
      if (!blob)
        return write({
          type: "blob",
          id,
          ok: false,
          error: { code: "invalid", message: "No blob is expected under it" },
        });
      if (!("sink" in blob))
        return refuseBlob(id, "This blob is taken in place, not read");
      expected.delete(id);
      try {
        if (!isAbsolute(file))
          throw new RunnerCallError({
            code: "invalid",
            message: "A blob path must be absolute",
          });
        if (!(await stat(file)).isFile())
          throw new RunnerCallError({
            code: "invalid",
            message: "A blob path must name a regular file",
          });
        await pipeline(createReadStream(file), blob.sink);
        blob.resolve();
        write({ type: "blob", id, ok: true });
      } catch (error) {
        const code = fileErrors[(error as { code?: string }).code ?? ""];
        const failure = code
          ? { code, message: `Cannot read the blob file (${code})` }
          : errorOf(error);
        blob.reject(new RunnerCallError(failure));
        if (!blob.sink.destroyed) blob.sink.destroy();
        write({ type: "blob", id, ok: false, error: failure });
      }
    };

    jsonLines(socket, (message) => {
      if (!trusted) {
        if (!socketHello.check(message) || message.nonce !== nonce)
          return socket.destroy();
        trusted = true;
        if (message.streamCredit) {
          send({ type: "stream", action: "accept" });
          streams.enable();
        }
        return;
      }
      if (blobPathFrame.check(message))
        return void (message.inPlace
          ? takePathBlob(message.id, message.path, message.inPlace.mustExist)
          : readPathBlob(message.id, message.path));
      const frame = message as {
        type?: unknown;
        id?: unknown;
        action?: unknown;
      };
      if (
        frame?.type === "stream" &&
        frame.action === "open" &&
        typeof frame.id === "string" &&
        expected.has(frame.id)
      ) {
        // A blob sent as bytes: hand the expected sink to the stream.
        const blob = expected.get(frame.id)!;
        expected.delete(frame.id);
        if ("sink" in blob)
          streams.receive(frame.id, blob.sink).then(blob.resolve, blob.reject);
        else
          blob.reject(
            new RunnerCallError({
              code: "invalid",
              message: "This blob is taken in place, not read",
            })
          );
      }
      if (streams.handle(message)) return;
      if (!socketRequest.check(message)) return socket.destroy();
      const { id, op, input } = message;
      const spec = (operations as Record<string, OperationSpec>)[op];
      const reply = (result: { value: Json } | { error: RunnerError }) => {
        if ("error" in result)
          return write({ id, ok: false, error: result.error });
        const text = JSON.stringify(result.value);
        if (text.length <= INLINE_REPLY_BYTES / 3)
          return write({ id, ok: true, value: result.value });
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length <= INLINE_REPLY_BYTES)
          return write({ id, ok: true, value: result.value });
        // Too long for one line: the caller registers the stream on this
        // answer, before it reads the stream's first frame.
        const stream = replyStream(id);
        write({ id, ok: true, stream });
        const chunks = (function* () {
          for (let at = 0; at < bytes.length; at += 64 * 1024)
            yield bytes.subarray(at, at + 64 * 1024);
        })();
        void streams.send(stream, Readable.from(chunks)).catch(() => {});
      };
      const release = fence ? fence.enter(op, input) : () => {};
      if (!release) return reply({ error: errorOf(fencedError()) });
      if (spec?.kind === "open")
        return void open(op, spec, input, opens, {
          ...context,
          emit: () => {},
        }).then((result) => {
          release();
          if ("error" in result) return reply(result);
          const ids = channelStreams(id);
          const { channel } = result;
          // Register before replying: the caller starts sending after it.
          void streams
            .receive(ids.in, channel, undefined, { stall: false })
            .catch(() => channel.destroy());
          reply({ value: result.info });
          void streams
            .send(ids.out, channel, undefined, { stall: false })
            .catch(() => channel.destroy());
        });
      let answered = false;
      const callContext: ConnectionContext = {
        ...context,
        emit(event) {
          if (!answered && spec?.events?.check(event))
            write({ id, event: event as Json });
        },
      };
      void call(op, spec, input, calls, callContext).then((result) => {
        answered = true;
        release();
        reply(result);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  return {
    close() {
      server.close();
      for (const socket of connections) socket.destroy();
      rmSync(path, { force: true });
    },
  };
}

function unsupported(op: string) {
  return {
    error: {
      code: "unsupported",
      message: `Unsupported operation: ${op}`,
    } as RunnerError,
  };
}

async function call(
  op: string,
  spec: OperationSpec | undefined,
  input: Json,
  handlers: CallHandlers,
  context: ConnectionContext
): Promise<{ value: Json } | { error: RunnerError }> {
  const handler = handlers[op as CallName] as
    | ((input: unknown, context: ConnectionContext) => unknown)
    | undefined;
  if (!spec || spec.kind !== "call" || !handler) return unsupported(op);
  if (!spec.request.check(input))
    return { error: { code: "invalid", message: `Invalid ${op} request` } };
  try {
    const value = await handler(input, context);
    if (!spec.response.check(value))
      return { error: { code: "failed", message: `Invalid ${op} response` } };
    return { value: value as Json };
  } catch (error) {
    return { error: errorOf(error) };
  }
}

async function open(
  op: string,
  spec: OperationSpec,
  input: Json,
  handlers: OpenHandlers,
  context: ConnectionContext
): Promise<{ info: Json; channel: Duplex } | { error: RunnerError }> {
  const handler = handlers[op as OpenName] as
    | ((
        input: unknown,
        context: ConnectionContext
      ) => Promise<{ info: unknown; channel: Duplex }>)
    | undefined;
  if (!handler) return unsupported(op);
  if (!spec.request.check(input))
    return { error: { code: "invalid", message: `Invalid ${op} request` } };
  try {
    const { info, channel } = await handler(input, context);
    if (!spec.response.check(info)) {
      channel.destroy();
      return { error: { code: "failed", message: `Invalid ${op} response` } };
    }
    return { info: info as Json, channel };
  } catch (error) {
    return { error: errorOf(error) };
  }
}
