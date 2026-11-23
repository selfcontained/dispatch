import { chmodSync, createReadStream, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex, Writable } from "node:stream";
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
  jsonLines,
  socketHello,
  socketRequest,
  type BlobPathReply,
  type SocketReply,
} from "@dispatch/runner-client/transport/local-socket";
import {
  FlowStreams,
  frameWriter,
  type StreamFrame,
} from "@dispatch/runner-client/v1/node";

/** What a handler may use of the connection its request arrived on. */
export type ConnectionContext = {
  /**
   * Expect a blob under `id` and write it into `sink`. The caller sends it as
   * bytes or, on this socket, as a file path. Register before the handler's
   * first `await`: frames after the request may already carry it.
   */
  receiveBlob(id: string, sink: Writable): Promise<void>;
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

type Expected = {
  sink: Writable;
  resolve(): void;
  reject(error: unknown): void;
};

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
 * it. Operations without a handler answer `unsupported`.
 */
export async function serveSocket(
  path: string,
  nonce: string,
  handlers: CallHandlers | Handlers
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
    const send = frameWriter<StreamFrame | SocketReply | BlobPathReply>(socket);
    const write = (frame: SocketReply | BlobPathReply) => {
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
    const context: ConnectionContext = {
      receiveBlob(id, sink) {
        return new Promise((resolve, reject) => {
          if (expected.has(id) || streams.has(id))
            return reject(new Error("Blob ID already in use"));
          expected.set(id, { sink, resolve, reject });
        });
      },
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
        return void readPathBlob(message.id, message.path);
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
        streams.receive(frame.id, blob.sink).then(blob.resolve, blob.reject);
      }
      if (streams.handle(message)) return;
      if (!socketRequest.check(message)) return socket.destroy();
      const { id, op, input } = message;
      const spec = (operations as Record<string, OperationSpec>)[op];
      const reply = (result: { value: Json } | { error: RunnerError }) =>
        write(
          "error" in result
            ? { id, ok: false, error: result.error }
            : { id, ok: true, value: result.value }
        );
      if (spec?.kind === "open")
        return void open(op, spec, input, opens, context).then((result) => {
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
      void call(op, spec, input, calls, context).then(reply);
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
