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
    // Repository fetches and engine package installs can run for minutes.
    const timeoutMs =
      command.kind === "sessionCheckout" ||
      command.kind === "checkoutRelease" ||
      command.kind === "inspectCheckout" ||
      command.kind === "viewCheckout" ||
      command.kind === "engine" ||
      (command.kind === "launch" &&
        (command.launch.repository || command.launch.prepareWorkspace))
        ? 300_000
        : 20_000;
    return new Promise((resolve, reject) => {
      const finish = (frame?: ResultFrame) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        this.progress.delete(id);
        if (!frame)
          reject(
            new RunnerUnavailable(
              "Runner acknowledgement was lost; execution is unknown."
            )
          );
        else if (frame.code === "host-gone")
          reject(new RunnerHostGone(frame.error));
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
        finish();
      }, timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, finish);
      try {
        this.send({ type: "request", id, command });
      } catch {
        finish();
      }
    });
  }
}
