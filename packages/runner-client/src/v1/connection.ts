import { checkoutCommandTimeoutMs } from "@dispatch/runner-protocol";
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

/** How long the service waits for a reply. The runner's update fence uses
 * the same bound as the deadline of an already-admitted operation. */
export function runnerReplyTimeoutMs(command: Command): number {
  // Repository fetches and engine package installs can run for minutes.
  // Let the runner enforce the command deadline and leave time for its reply.
  if (command.kind === "checkoutCommand")
    return runnerDeadlineMs(
      "request",
      checkoutCommandTimeoutMs(command.operation.checkout),
      0
    );
  return command.kind === "sessionCheckout" ||
    command.kind === "checkoutRelease" ||
    isStreamedFile(command) ||
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
    if (command.kind === "checkoutCommand" || isStreamedFile(command))
      signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const channel = openChannel
      ? hostChannel(id, this.send, () => this.channels.delete(id))
      : undefined;
    // The consumer can attach its error listener after the request resolves.
    channel?.on("error", () => {});
    if (channel) this.channels.set(id, channel);
    if (
      command.kind === "launch" &&
      command.launch.prepareWorkspace &&
      onProgress
    )
      this.progress.set(id, onProgress);
    try {
      const value = await this.sendRequest(
        id,
        command,
        command.kind === "checkoutCommand" || isStreamedFile(command)
          ? signal
          : undefined
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
    const timeoutMs = runnerReplyTimeoutMs(command);
    const checkoutReplyTimeoutMs =
      command.kind === "checkoutCommand" ? timeoutMs : undefined;
    return new Promise((resolve, reject) => {
      const unknown = "Runner acknowledgement was lost; execution is unknown.";
      // No frame: the connection closed after sending (`close()` settles
      // with nothing), unless a timeout or failed send says otherwise.
      const finish = (frame?: ResultFrame, failure?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        this.progress.delete(id);
        if (!frame) reject(failure ?? new RunnerAcknowledgementLost(unknown));
        else if (frame.code === "host-gone")
          reject(new RunnerHostGone(frame.error));
        else if (frame.code === "update-fenced")
          reject(new RunnerUpdateFenced(frame.error));
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
              : "File stream cancelled."
          )
        );
      };
      const timer = setTimeout(() => {
        if (command.kind === "checkoutCommand") requestCancel();
        finish(
          undefined,
          new RunnerUnavailable(
            checkoutReplyTimeoutMs === undefined
              ? unknown
              : `No runner checkout command reply after ${checkoutReplyTimeoutMs / 1000} seconds; execution is unknown.`
          )
        );
      }, timeoutMs);
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
