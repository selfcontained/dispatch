/*
 * The local socket, first version: one JSON line per message. A connection
 * opens with `{nonce}` (the spawn's nonce) and then carries calls. Only
 * `call` operations. L2 will bind operations and blob paths to the negotiated
 * stream transport and add reconnect rules.
 */
import { connect } from "node:net";
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
  type Infer,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";

export const socketHello = object({
  nonce: string,
  streamCredit: optional(literal(true)),
});
export const socketRequest = object({ id: integer, op: string, input: json });
export const socketReply = union(
  object({ id: integer, ok: literal(true), value: json }),
  object({ id: integer, ok: literal(false), error: runnerError })
);
export type SocketRequest = Infer<typeof socketRequest>;
export type SocketReply = Infer<typeof socketReply>;

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

/** One call over a fresh connection. Errors are `RunnerCallError`. */
export function callLocalSocket<K extends CallName>(
  socketPath: string,
  nonce: string,
  op: K,
  input: Req<K>,
  timeoutMs = 5_000
): Promise<Res<K>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const fail = (message: string, code: "unavailable" | "unknown_outcome") => {
      socket.destroy();
      reject(new RunnerCallError({ code, message }));
    };
    let sent = false;
    const timer = setTimeout(
      () => fail("Local runner did not answer", "unknown_outcome"),
      timeoutMs
    );
    socket.on("error", () =>
      fail(
        "Local runner is unavailable",
        sent ? "unknown_outcome" : "unavailable"
      )
    );
    socket.on("close", () =>
      fail(
        "Local runner closed the connection",
        sent ? "unknown_outcome" : "unavailable"
      )
    );
    socket.on("connect", () => {
      socket.write(JSON.stringify({ nonce }) + "\n");
      socket.write(JSON.stringify({ id: 1, op, input }) + "\n");
      sent = true;
    });
    jsonLines(socket, (reply) => {
      clearTimeout(timer);
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      socket.end();
      if (!socketReply.check(reply) || reply.id !== 1)
        return reject(
          new RunnerCallError({ code: "failed", message: "Malformed reply" })
        );
      if (!reply.ok) return reject(new RunnerCallError(reply.error));
      const response = operations[op].response;
      if (!response.check(reply.value))
        return reject(
          new RunnerCallError({
            code: "failed",
            message: `Invalid ${op} reply`,
          })
        );
      resolve(reply.value as Res<K>);
    });
  });
}
