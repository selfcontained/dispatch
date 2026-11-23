/*
 * The contract's `Runner` over one wire v1 connection, built only from the
 * client package: the codec encodes each call as a v1 command and decodes
 * the result. Operations v1 cannot carry (`NOT_ON_V1`) answer `unsupported`.
 * `checkout.read` uses v1's guarded read, the one v1 read with a digest.
 */
import type { Duplex } from "node:stream";
import {
  RUNNER_WIRE_VERSION,
  type ReadyFrame,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  clientMessage,
  hostMessage,
  runnerIdFromWire,
  sessionToWire,
  type CallName,
  type CallOptions,
  type CallerChannel,
  type ErrorCode,
  type OpenName,
  type Req,
  type Res,
  type Runner,
  type RunnerDescription,
  type SessionHandle,
} from "@dispatch/runner-protocol/contract";
import {
  CodecError,
  NOT_ON_V1,
  ResultError,
  decodeResult,
  encodeCommand,
  type Decoded,
} from "@dispatch/runner-client/v1";
import {
  receiveFile,
  receiveCheckoutExec,
  RunnerAcknowledgementLost,
  RunnerHostGone,
  RunnerUnavailable,
  RunnerUpdateFenced,
  type RunnerConnection,
} from "@dispatch/runner-client/v1/connection";
import {
  decodeHostFrame,
  type ClientMessage,
  type HostMessage,
} from "@dispatch/runner-client/v1/host";
import { wireFrames, type FlowStreams } from "@dispatch/runner-client/v1/node";

const fail = (code: ErrorCode, message: string) =>
  new RunnerCallError({ code, message });

function transportError(error: unknown, signal?: AbortSignal) {
  if (error instanceof RunnerCallError) return error;
  if (error instanceof ResultError) return new RunnerCallError(error.error);
  const message = (error as Error).message ?? String(error);
  if (signal?.aborted) return fail("cancelled", message);
  if (error instanceof RunnerAcknowledgementLost)
    return fail("unknown_outcome", message);
  if (error instanceof RunnerUnavailable) return fail("unavailable", message);
  if (error instanceof RunnerHostGone) return fail("host_gone", message);
  if (error instanceof RunnerUpdateFenced) return fail("fenced", message);
  return fail("failed", message);
}

function sessionChannel(socket: Duplex): CallerChannel<"session.attach"> {
  const events = new Set<(message: HostMessage) => void>();
  let failure: { code: "failed"; message: string } | undefined;
  const send = wireFrames<Record<string, unknown>, ClientMessage>(
    socket,
    (frame) => {
      let message;
      try {
        message = decodeHostFrame(frame);
        if (!hostMessage.check(message)) throw new Error();
      } catch {
        failure = {
          code: "failed",
          message: "Host message is outside its schema.",
        };
        socket.destroy();
        return;
      }
      for (const listener of events) listener(message);
    }
  );
  socket.on("error", (error) => {
    failure ??= { code: "failed", message: error.message };
  });
  return {
    write(message) {
      if (!clientMessage.check(message))
        throw fail("invalid", "Client message is outside its schema.");
      send(message);
    },
    onData(listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    onClose(listener) {
      const closed = () => listener(failure);
      socket.on("close", closed);
      return () => {
        socket.off("close", closed);
      };
    },
    close: () => socket.destroy(),
  };
}

export type V1RunnerOptions = {
  connection: RunnerConnection;
  streams?: FlowStreams;
  ready: ReadyFrame;
  runnerId: string;
  displayName: string;
  /** v1 addresses everything inside a workspace the runner advertised. */
  workspace: string;
};

export function v1Runner({
  connection,
  streams,
  ready,
  runnerId,
  displayName,
  workspace,
}: V1RunnerOptions): Runner {
  const description: RunnerDescription = {
    runnerId: runnerIdFromWire(runnerId),
    displayName,
    build: { version: "" },
    protocol: ready.version ?? RUNNER_WIRE_VERSION,
    engines: [],
    capabilities: {},
  };
  return {
    describe: () => description,
    connection: { state: "ready", epoch: 0, onChange: () => () => {} },
    async call<K extends CallName>(
      op: K,
      request: Req<K>,
      opts?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op in NOT_ON_V1)
        throw fail(
          "unsupported",
          `${op} is not on wire v1: ${NOT_ON_V1[op as keyof typeof NOT_ON_V1]}`
        );
      const session = request as {
        session?: SessionHandle;
        target?: { session?: SessionHandle };
      };
      const handle = session.session ?? session.target?.session;
      const frame: Decoded<K> = {
        op,
        request,
        extras: {
          workspace,
          agentId: handle ? sessionToWire(handle) : "runner",
          // Only v1's command-family read returns the digest a guard needs.
          ...(op === "checkout.read" && { checkoutCommand: true }),
        },
        absent: [],
      };
      let command;
      try {
        command = encodeCommand(frame);
      } catch (error) {
        if (error instanceof CodecError)
          throw fail("unsupported", error.message);
        throw error;
      }
      try {
        if (
          command.kind === "sessionFile" &&
          command.operation.kind === "collect"
        ) {
          const bytes = await receiveFile(
            { ...command, operation: command.operation },
            (command, signal) => connection.request(command, { signal }),
            ready.filesGetStream ? streams : undefined
          );
          return decodeResult(frame, bytes.toString("base64"));
        }
        if (command.kind === "checkoutCommand" && op === "checkout.exec") {
          const { timeoutMs, maxOutput, shell, env } =
            request as Req<"checkout.exec">;
          const result = await receiveCheckoutExec(
            command,
            { timeoutMs, maxOutput, shell, env },
            (command, signal) => connection.request(command, { signal }),
            ready.checkoutExecStream ? streams : undefined,
            opts?.signal
          );
          return result.streamed
            ? (result.result as Res<K>)
            : decodeResult(frame, result.value);
        }
        const { value } = await connection.request(command, {
          signal: opts?.signal,
        });
        return decodeResult(frame, value);
      } catch (error) {
        throw transportError(error, opts?.signal);
      }
    },
    async open<K extends OpenName>(
      op: K,
      request: Req<K>,
      opts?: CallOptions<K>
    ) {
      if (op !== "session.attach")
        throw fail("unsupported", `${op} channels are not on this client yet.`);
      const frame: Decoded<K> = {
        op,
        request,
        extras: { workspace },
        absent: [],
      };
      try {
        opts?.signal?.throwIfAborted();
        const { value, channel } = await connection.request(
          encodeCommand(frame),
          {
            openChannel: true,
          }
        );
        if (!channel) throw fail("failed", "Missing v1 attach channel.");
        if (opts?.signal?.aborted) {
          channel.destroy();
          opts.signal.throwIfAborted();
        }
        return {
          info: decodeResult(frame, value),
          channel: sessionChannel(channel) as CallerChannel<K>,
        };
      } catch (error) {
        throw transportError(error, opts?.signal);
      }
    },
  };
}
