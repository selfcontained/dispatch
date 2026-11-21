import { checkoutCommandTimeoutMs } from "./checkout-command.js";
import type { Duplex } from "node:stream";
import type {
  ChannelFrame,
  Command,
  ResultFrame,
  LaunchProgress,
  LaunchProgressFrame,
  ServiceFrame,
} from "./index.js";
import { hostChannel } from "./node.js";

export class RunnerUnavailable extends Error {}
export class RunnerHostGone extends Error {}
/** The runner's update fence refused the request before it started. */
export class RunnerUpdateFenced extends Error {}
/** The request was sent and its connection closed before any reply: the
 * runner may or may not have run it. */
export class RunnerAcknowledgementLost extends RunnerUnavailable {}

/** How long the service waits for a reply. The runner's update fence uses
 * the same bound as the deadline of an already-admitted operation. */
export function runnerReplyTimeoutMs(command: Command): number {
  // Repository fetches and engine package installs can run for minutes.
  // Let the runner enforce the command deadline and leave time for its reply.
  if (command.kind === "checkoutCommand")
    return checkoutCommandTimeoutMs(command.operation.checkout) + 5_000;
  return command.kind === "sessionCheckout" ||
    command.kind === "checkoutRelease" ||
    command.kind === "inspectCheckout" ||
    command.kind === "viewCheckout" ||
    command.kind === "engine" ||
    (command.kind === "launch" &&
      (command.launch.repository || command.launch.prepareWorkspace))
    ? 300_000
    : 20_000;
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
    if (command.kind === "checkoutCommand") signal?.throwIfAborted();
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
        command.kind === "checkoutCommand" ? signal : undefined
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
        requestCancel();
        finish({
          type: "result",
          id,
          error: "Checkout command cancelled.",
        });
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
