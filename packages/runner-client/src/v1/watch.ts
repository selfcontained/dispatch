import type { Duplex } from "node:stream";
import type { CallerChannel } from "@dispatch/runner-protocol/contract";

/**
 * Wire v1's `watchCheckout` channel as the caller's end of `checkout.watch`:
 * one chunk per burst of changes, closed when the runner ends the watch.
 * Closing it ends the watch on the runner.
 */
export function watchChannel(channel: Duplex): CallerChannel<"checkout.watch"> {
  let ended = false;
  const closes = new Set<() => void>();
  const end = () => {
    if (ended) return;
    ended = true;
    channel.destroy();
    for (const listener of closes) listener();
  };
  channel.once("end", end);
  channel.once("close", end);
  channel.on("error", () => {});
  return {
    write() {},
    onData(listener) {
      const forward = (chunk: Buffer) => listener(chunk);
      channel.on("data", forward);
      return () => channel.off("data", forward);
    },
    onClose(listener) {
      if (ended) {
        queueMicrotask(listener);
        return () => {};
      }
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: end,
  };
}
