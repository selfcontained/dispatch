import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  operations,
  type CallName,
  type Json,
  type OperationSpec,
  type RunnerError,
} from "@dispatch/runner-protocol/contract";
import {
  jsonLines,
  socketHello,
  socketRequest,
  type SocketReply,
} from "@dispatch/runner-client/transport/local-socket";

export type CallHandlers = Partial<{
  [K in CallName]: () => Promise<unknown> | unknown;
}>;

/**
 * The child's socket. Each connection must open with the spawn's nonce; any
 * other first line closes it. Operations without a handler answer
 * `unsupported`.
 */
export async function serveSocket(
  path: string,
  nonce: string,
  handlers: CallHandlers
): Promise<{ close(): void }> {
  rmSync(path, { force: true }); // Safe: the state lock is held.
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    let trusted = false;
    jsonLines(socket, (message) => {
      if (!trusted) {
        if (!socketHello.check(message) || message.nonce !== nonce)
          return socket.destroy();
        trusted = true;
        return;
      }
      if (!socketRequest.check(message)) return socket.destroy();
      void answer(message.op, message.input, handlers).then((result) => {
        const reply: SocketReply =
          "error" in result
            ? { id: message.id, ok: false, error: result.error }
            : { id: message.id, ok: true, value: result.value };
        if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
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

async function answer(
  op: string,
  input: Json,
  handlers: CallHandlers
): Promise<{ value: Json } | { error: RunnerError }> {
  const spec = (operations as Record<string, OperationSpec>)[op];
  const handler = handlers[op as CallName];
  if (!spec || spec.kind !== "call" || !handler)
    return {
      error: { code: "unsupported", message: `Unsupported operation: ${op}` },
    };
  if (!spec.request.check(input))
    return { error: { code: "invalid", message: `Invalid ${op} request` } };
  try {
    const value = await handler();
    if (!spec.response.check(value))
      return { error: { code: "failed", message: `Invalid ${op} response` } };
    return { value: value as Json };
  } catch (error) {
    return {
      error: {
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
