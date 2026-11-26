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
  downloadStream,
  INLINE_REPLY_BYTES,
  jsonLines,
  replyStream,
  socketHello,
  socketCancel,
  socketRequest,
  type BlobPathReply,
  type SocketEvent,
  type SocketReply,
} from "@dispatch/runner-client/transport/local-socket";
import {
  CONNECTION_WINDOW,
  FlowStreams,
  frameWriter,
  type StreamFrame,
} from "@dispatch/runner-client/v1/node";
import { fencedError, type WriteFence } from "./fence.js";

import type {
  ConnectionContext,
  CallHandlers,
  OpenHandlers,
  Handlers,
  InPlaceBlob,
} from "../handlers.js";
export type {
  ConnectionContext,
  CallHandlers,
  OpenHandlers,
  Handlers,
  InPlaceBlob,
} from "../handlers.js";

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
  rmSync(path, { force: true }); // Safe: the state lock is held.
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveOperationSocket(socket, { kind: "local", nonce }, handlers, fence);
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

/** The caller authenticates an enrolled socket before admitting operation frames. */
export function serveOperationSocket(
  socket: Duplex,
  endpoint: { kind: "local"; nonce: string } | { kind: "enrolled" },
  handlers: CallHandlers | Handlers,
  fence?: Pick<WriteFence, "enter">
) {
  const { calls, opens = {} } =
    "calls" in handlers ? (handlers as Handlers) : { calls: handlers };
  socket.on("error", () => socket.destroy());
  let trusted = endpoint.kind === "enrolled";
  const send = frameWriter<
    StreamFrame | SocketReply | SocketEvent | BlobPathReply
  >(socket);
  const commands = new Map<number, AbortController>();
  const pendingFlushes = new Set<() => void>();
  socket.once("close", () => {
    for (const command of commands.values()) command.abort();
    commands.clear();
    for (const flushed of pendingFlushes) flushed();
  });
  const write = (
    frame: SocketReply | SocketEvent | BlobPathReply,
    release?: () => void
  ) => {
    // A protected update can take over once admitted work has settled and
    // its first reply reached the socket (or the connection was lost).
    if (socket.destroyed) return release?.();
    function flushed() {
      if (pendingFlushes.delete(flushed)) release?.();
    }
    if (release) pendingFlushes.add(flushed);
    try {
      send(frame, release ? flushed : undefined);
    } catch {
      flushed();
    }
  };
  const streams = new FlowStreams(
    socket,
    send,
    undefined,
    endpoint.kind === "enrolled" ? CONNECTION_WINDOW : undefined
  );
  if (trusted) streams.enable();
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

  if (endpoint.kind === "enrolled") delete context.receiveBlobPath;

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
      if (
        !socketHello.check(message) ||
        endpoint.kind !== "local" ||
        message.nonce !== endpoint.nonce
      )
        return socket.destroy();
      trusted = true;
      if (message.streamCredit) {
        send({ type: "stream", action: "accept" });
        streams.enable();
      }
      return;
    }
    if (endpoint.kind === "local" && blobPathFrame.check(message))
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
    if (endpoint.kind === "enrolled" && socketCancel.check(message)) {
      commands.get(message.id)?.abort();
      return;
    }
    if (!socketRequest.check(message)) return socket.destroy();
    const { id, op, input } = message;
    if (commands.has(id)) return socket.destroy();
    const spec = (operations as Record<string, OperationSpec>)[op];
    const reply = (
      result: { value: Json } | { error: RunnerError },
      release?: () => void
    ) => {
      if (endpoint.kind === "local") {
        release?.();
        release = undefined;
      }
      if ("error" in result)
        return write({ id, ok: false, error: result.error }, release);
      const text = JSON.stringify(result.value);
      if (text.length <= INLINE_REPLY_BYTES / 3)
        return write({ id, ok: true, value: result.value }, release);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length <= INLINE_REPLY_BYTES)
        return write({ id, ok: true, value: result.value }, release);
      // Too long for one line: the caller registers the stream on this
      // answer, before it reads the stream's first frame.
      const stream = replyStream(id);
      write({ id, ok: true, stream }, release);
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
        if ("error" in result) return reply(result, release);
        const ids = channelStreams(id);
        const { channel } = result;
        // Register before replying: the caller starts sending after it.
        void streams
          .receive(ids.in, channel, undefined, { stall: false })
          .catch(() => channel.destroy());
        reply({ value: result.info }, release);
        void streams
          .send(ids.out, channel, undefined, { stall: false })
          .catch(() => channel.destroy());
      });
    const command =
      endpoint.kind === "enrolled" && spec?.cancellable
        ? new AbortController()
        : undefined;
    if (command) commands.set(id, command);
    let answered = false;
    const callContext: ConnectionContext = {
      ...context,
      ...(command && { signal: command.signal }),
      ...(endpoint.kind === "enrolled" &&
        op === "files.get" && {
          async sendFile(source: Readable) {
            const blob = downloadStream(id);
            await streams.send(blob, source);
            return blob;
          },
        }),
      emit(event) {
        if (!answered && spec?.events?.check(event))
          write({ id, event: event as Json });
      },
    };
    void call(op, spec, input, calls, callContext).then((result) => {
      answered = true;
      if (command) commands.delete(id);
      reply(result, release);
    });
  });
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
