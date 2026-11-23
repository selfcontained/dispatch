import {
  operations,
  runnerError,
  sessionToWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import type {
  CheckoutReadName,
  CheckoutReadRequest,
} from "@dispatch/runner-protocol";
import {
  checkoutCommandTimeoutMs,
  isCheckoutCommandStatus,
  type CheckoutExecution,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { Timeout } from "@dispatch/runner-protocol/contract";
import { randomUUID } from "node:crypto";
import { Writable, type Duplex, type Readable } from "node:stream";
import { isSessionFileData } from "@dispatch/runner-protocol";
import type { FlowStreams } from "./streams.js";
import type {
  ChannelFrame,
  Command,
  ResultFrame,
  LaunchProgress,
  LaunchProgressFrame,
  ServiceFrame,
} from "@dispatch/runner-protocol";
import { hostChannel } from "./node.js";

export class RunnerUnavailable extends Error {}
export class RunnerHostGone extends Error {}
/** The runner's update fence refused the request before it started. */
export class RunnerUpdateFenced extends Error {}
/** The request was sent and its connection closed before any reply: the
 * runner may or may not have run it. */
export class RunnerAcknowledgementLost extends RunnerUnavailable {}

/** Contract deadlines. A null request timeout keeps the encoded v1 deadline. */
export function runnerDeadlineMs(
  timeout: Timeout,
  requestTimeoutMs: number | null,
  v1DeadlineMs: number
): number {
  if (timeout === "request")
    return requestTimeoutMs === null ? v1DeadlineMs : requestTimeoutMs + 5_000;
  return timeout === "long" ? 300_000 : 20_000;
}

function executionOptions(command: Command) {
  return command.kind === "checkoutCommand" && command.operation.kind === "run"
    ? command.operation.execution
    : undefined;
}

/** Node timers clamp values outside the signed 32-bit range to one ms. */
export function scheduleDeadline(ms: number, expired: () => void) {
  const deadline = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) expired();
    else
      timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2_147_483_647));
  };
  timer = setTimeout(tick, Math.min(ms, 2_147_483_647));
  return () => clearTimeout(timer);
}

/** Legacy reply deadline, also used by the runner as its update drain
 * budget. An unbounded exec can defer an update without ending the command. */
export function runnerReplyTimeoutMs(command: Command): number {
  // Repository fetches and engine package installs can run for minutes.
  // Let the runner enforce the command deadline and leave time for its reply.
  if (command.kind === "checkoutCommand") {
    const timeoutMs =
      executionOptions(command)?.timeoutMs ??
      checkoutCommandTimeoutMs(command.operation.checkout);
    return runnerDeadlineMs("request", Math.min(timeoutMs, 2_147_470_000), 0);
  }
  return command.kind === "workspacePrepare" ||
    command.kind === "workspaceResume" ||
    command.kind === "sessionCheckout" ||
    command.kind === "checkoutRelease" ||
    isStreamedFile(command) ||
    command.kind === "checkoutRead" ||
    command.kind === "inspectCheckout" ||
    command.kind === "viewCheckout" ||
    command.kind === "engine" ||
    (command.kind === "launch" &&
      (command.launch.repository || command.launch.prepareWorkspace))
    ? runnerDeadlineMs("long", null, 0)
    : runnerDeadlineMs("default", null, 0);
}

/** A session file whose bytes travel on a stream: bounded by progress, not a reply deadline. */
function isStreamedFile(command: Command) {
  return (
    command.kind === "sessionFile" && command.operation.streamId !== undefined
  );
}

type CollectCommand = Extract<Command, { kind: "sessionFile" }> & {
  operation: { kind: "collect"; path: string; streamId?: string };
};

/** Receive raw bytes when supported. The v1 fallback keeps its original frame. */
export async function receiveFile(
  command: CollectCommand,
  request: (
    command: CollectCommand,
    signal?: AbortSignal
  ) => Promise<{ value: unknown }>,
  streams?: FlowStreams
): Promise<Buffer> {
  if (!streams) {
    const { value } = await request(command);
    if (!isSessionFileData(value))
      throw new Error("Invalid runner file response.");
    return Buffer.from(value, "base64");
  }
  const id = randomUUID();
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  const stream = streams.receive(
    id,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
    controller.signal
  );
  try {
    const [, { value }] = await Promise.all([
      stream,
      request(
        { ...command, operation: { ...command.operation, streamId: id } },
        controller.signal
      ),
    ]);
    if (value !== true) throw new Error("Invalid runner file stream response.");
    return Buffer.concat(chunks);
  } finally {
    controller.abort();
  }
}

type ExecCommand = Extract<Command, { kind: "checkoutCommand" }>;

/** Commands with negotiated execution options acknowledge with status only. */
export async function receiveCheckoutExec(
  command: ExecCommand,
  options: Omit<CheckoutExecution, "stdout" | "stderr">,
  request: (
    command: ExecCommand,
    signal?: AbortSignal
  ) => Promise<{ value: ResultFrame["value"] }>,
  streams?: FlowStreams,
  signal?: AbortSignal
): Promise<
  | { value: ResultFrame["value"]; streamed: false }
  | { result: CheckoutCommandResult; streamed: true }
> {
  if (!streams) return { ...(await request(command, signal)), streamed: false };
  if (command.operation.kind !== "run")
    throw new Error("Expected a checkout run.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const stdout = randomUUID();
  const stderr = randomUUID();
  const output = (id: string) => {
    const chunks: Buffer[] = [];
    return streams
      .receive(
        id,
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        }),
        active,
        { stall: false }
      )
      .then(() => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        const limit = options.maxOutput;
        if (limit === null || Buffer.byteLength(text) <= limit)
          return { text, truncated: false };
        return {
          text: new TextDecoder().decode(Buffer.from(text).subarray(0, limit), {
            stream: true,
          }),
          truncated: true,
        };
      });
  };
  try {
    const [out, err, { value }] = await Promise.all([
      output(stdout),
      output(stderr),
      request(
        {
          ...command,
          operation: {
            ...command.operation,
            execution: { ...options, stdout, stderr },
          },
        },
        active
      ),
    ]);
    const status: unknown =
      typeof value === "string" ? JSON.parse(value) : null;
    if (!isCheckoutCommandStatus(status))
      throw new Error("Invalid runner checkout command status.");
    return {
      streamed: true,
      result: {
        exitCode: status.exitCode,
        stdout: out.text,
        stderr: err.text,
        ...(options.maxOutput !== null && {
          truncated: Boolean(
            status.truncated || out.truncated || err.truncated
          ),
        }),
      },
    };
  } finally {
    controller.abort();
  }
}

/** Collect a contract result from the bound checkout's credit-controlled stream. */
export async function receiveCheckoutRead<K extends CheckoutReadName>(
  op: K,
  input: Req<K>,
  workspace: string,
  request: (
    command: Extract<Command, { kind: "checkoutRead" }>,
    signal: AbortSignal
  ) => Promise<{ value: unknown }>,
  streams: FlowStreams,
  signal?: AbortSignal
): Promise<Res<K>> {
  const { target, ...parameters } = input as Req<CheckoutReadName>;
  if (!("session" in target) || (target.checkout ?? "current") !== "current")
    throw new RunnerCallError({
      code: "invalid",
      message: "Expected a current session checkout.",
    });
  const operation = { op, request: parameters } as CheckoutReadRequest;
  const streamId = randomUUID();
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  active.throwIfAborted();
  const chunks: Buffer[] = [];
  try {
    const [, { value }] = await Promise.all([
      streams.receive(
        streamId,
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        }),
        active,
        { stall: false }
      ),
      request(
        {
          kind: "checkoutRead",
          workspace,
          agentId: sessionToWire(target.session),
          operation: { ...operation, streamId },
        },
        active
      ),
    ]);
    if (value !== true)
      throw new Error("Invalid runner checkout stream response.");
    const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (runnerError.check(reply?.error)) throw new RunnerCallError(reply.error);
    if (!operations[op].response.check(reply?.data))
      throw new Error("Invalid runner checkout read response.");
    return reply.data as Res<K>;
  } finally {
    controller.abort();
  }
}

type DeliverCommand = Extract<Command, { kind: "sessionFile" }> & {
  operation: { kind: "deliver" };
};

/** The bytes of one file to hand to the runner. */
export type FileSource = {
  size: number;
  /** A fresh read of the bytes, for a stream. */
  open(): Readable;
  /** The whole file, for the v1 frame. */
  read(): Promise<Buffer>;
};

/**
 * Hand a file to the runner. With streams the bytes follow the request on a
 * flow-controlled stream; the v1 fallback keeps its original inline frame.
 * `request` must write its frame before it first awaits: the stream opens
 * right after it, and the runner registers its sink on that frame.
 */
export async function sendFile(
  command: Omit<DeliverCommand, "operation">,
  name: string,
  source: FileSource,
  request: (
    command: DeliverCommand,
    signal?: AbortSignal
  ) => Promise<{ value: unknown }>,
  streams?: FlowStreams
): Promise<unknown> {
  if (!streams) {
    const data = (await source.read()).toString("base64");
    const { value } = await request({
      ...command,
      operation: { kind: "deliver", name, data },
    });
    return value;
  }
  const id = randomUUID();
  const controller = new AbortController();
  const reply = request(
    {
      ...command,
      operation: { kind: "deliver", name, streamId: id, size: source.size },
    },
    controller.signal
  );
  const sent = streams.send(id, source.open(), controller.signal);
  try {
    const [{ value }] = await Promise.all([reply, sent]);
    return value;
  } finally {
    controller.abort();
    // Whichever side failed first, the other is settled by the abort.
    await Promise.allSettled([reply, sent]);
  }
}

/** Service side of one authenticated runner connection. Request IDs and channels are local to it. */
export class RunnerConnection {
  private readonly pending = new Map<string, (frame?: ResultFrame) => void>();
  private readonly progress = new Map<
    string,
    (progress: LaunchProgress) => void
  >();
  private readonly channels = new Map<string, Duplex>();
  private closed = false;

  constructor(private readonly send: (frame: ServiceFrame) => void) {}

  receive(frame: ChannelFrame | ResultFrame | LaunchProgressFrame) {
    switch (frame.type) {
      case "launch_progress":
        this.progress.get(frame.id)?.(frame.progress);
        break;
      case "result":
        this.pending.get(frame.id)?.(frame);
        break;
      case "data":
        this.channels.get(frame.id)?.push(Buffer.from(frame.data, "base64"));
        break;
      case "close":
        this.channels.get(frame.id)?.push(null);
        break;
    }
  }

  close() {
    this.closed = true;
    for (const settle of this.pending.values()) settle();
    for (const channel of this.channels.values()) channel.push(null);
    this.channels.clear();
  }

  async request(
    command: Command,
    {
      openChannel = false,
      onProgress,
      signal,
    }: {
      openChannel?: boolean;
      signal?: AbortSignal;
      onProgress?: (progress: LaunchProgress) => void;
    } = {}
  ) {
    if (this.closed)
      throw new RunnerUnavailable("The runner connection is closed.");
    const cancellable =
      command.kind === "checkoutCommand" ||
      command.kind === "checkoutRead" ||
      isStreamedFile(command) ||
      (command.kind === "openTerminal" && command.stream !== undefined);
    if (cancellable) signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const channel = openChannel
      ? hostChannel(id, this.send, () => this.channels.delete(id))
      : undefined;
    // The consumer can attach its error listener after the request resolves.
    channel?.on("error", () => {});
    if (channel) this.channels.set(id, channel);
    if (
      onProgress &&
      (command.kind === "workspacePrepare" ||
        command.kind === "workspaceResume" ||
        (command.kind === "launch" && command.launch.prepareWorkspace))
    )
      this.progress.set(id, onProgress);
    try {
      const value = await this.sendRequest(
        id,
        command,
        cancellable ? signal : undefined
      );
      return { value, channel };
    } catch (error) {
      channel?.destroy();
      throw error;
    }
  }

  private sendRequest(
    id: string,
    command: Command,
    signal?: AbortSignal
  ): Promise<ResultFrame["value"]> {
    const execution = executionOptions(command);
    const timeoutMs = execution
      ? execution.timeoutMs === null
        ? null
        : execution.timeoutMs + 5_000
      : runnerReplyTimeoutMs(command);
    const checkoutReplyTimeoutMs =
      command.kind === "checkoutCommand" ? timeoutMs : undefined;
    return new Promise((resolve, reject) => {
      const unknown = "Runner acknowledgement was lost; execution is unknown.";
      // No frame: the connection closed after sending (`close()` settles
      // with nothing), unless a timeout or failed send says otherwise.
      const finish = (frame?: ResultFrame, failure?: Error) => {
        stopTimer?.();
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        this.progress.delete(id);
        if (!frame) reject(failure ?? new RunnerAcknowledgementLost(unknown));
        else if (frame.code === "host-gone")
          reject(new RunnerHostGone(frame.error));
        else if (frame.code === "update-fenced")
          reject(new RunnerUpdateFenced(frame.error));
        else if (
          execution &&
          (frame.code === "stale" || frame.code === "timeout")
        )
          reject(
            new RunnerCallError({
              code: frame.code,
              message: frame.error ?? "Runner checkout command failed.",
            })
          );
        else if (frame.error) reject(new Error(frame.error));
        else resolve(frame.value);
      };
      const requestCancel = () => {
        try {
          this.send({ type: "cancel_checkout_command", id });
        } catch {
          // The connection may already have failed.
        }
      };
      const cancel = () => {
        if (command.kind === "checkoutCommand") requestCancel();
        finish(
          undefined,
          new Error(
            command.kind === "checkoutCommand"
              ? "Checkout command cancelled."
              : command.kind === "checkoutRead"
                ? "Checkout read cancelled."
                : command.kind === "openTerminal"
                  ? "Terminal stream cancelled."
                  : "File stream cancelled."
          )
        );
      };
      const expire = () => {
        if (command.kind === "checkoutCommand") requestCancel();
        finish(
          undefined,
          new RunnerUnavailable(
            checkoutReplyTimeoutMs == null
              ? unknown
              : `No runner checkout command reply after ${checkoutReplyTimeoutMs / 1000} seconds; execution is unknown.`
          )
        );
      };
      let stopTimer: (() => void) | undefined;
      if (timeoutMs !== null) {
        if (execution) stopTimer = scheduleDeadline(timeoutMs, expire);
        else {
          const timer = setTimeout(expire, timeoutMs);
          stopTimer = () => clearTimeout(timer);
        }
      }
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, finish);
      try {
        this.send({ type: "request", id, command });
      } catch {
        finish(undefined, new RunnerUnavailable(unknown));
      }
    });
  }
}
