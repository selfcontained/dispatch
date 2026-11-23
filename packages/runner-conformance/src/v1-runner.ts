/*
 * The contract's `Runner` over one wire v1 connection, built only from the
 * client package: the codec encodes each call as a v1 command and decodes
 * the result. Operations v1 cannot carry (`NOT_ON_V1`) answer `unsupported`.
 * `checkout.read` uses v1's guarded read, the one v1 read with a digest.
 */
import {
  RUNNER_WIRE_VERSION,
  type ReadyFrame,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  runnerIdFromWire,
  sessionToWire,
  type CallName,
  type CallOptions,
  type ErrorCode,
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
  RunnerAcknowledgementLost,
  RunnerHostGone,
  RunnerUnavailable,
  RunnerUpdateFenced,
  type RunnerConnection,
} from "@dispatch/runner-client/v1/connection";

const fail = (code: ErrorCode, message: string) =>
  new RunnerCallError({ code, message });

function transportError(error: unknown, signal?: AbortSignal) {
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

export type V1RunnerOptions = {
  connection: RunnerConnection;
  ready: ReadyFrame;
  runnerId: string;
  displayName: string;
  /** v1 addresses everything inside a workspace the runner advertised. */
  workspace: string;
};

export function v1Runner({
  connection,
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
        const { value } = await connection.request(command, {
          signal: opts?.signal,
        });
        return decodeResult(frame, value);
      } catch (error) {
        throw transportError(error, opts?.signal);
      }
    },
    async open(op) {
      throw fail("unsupported", `${op} channels are not on this client yet.`);
    },
  };
}
