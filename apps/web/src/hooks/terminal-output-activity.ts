import type { TerminalOutputActivity } from "@/lib/store";

/** Minimum gap between two writes: at most four a second. */
export const OUTPUT_ACTIVITY_THROTTLE_MS = 250;

export type OutputActivityTracker = {
  /** Called on every output chunk the terminal socket delivers. */
  note: (chunk: string) => void;
  /** Cancels a pending trailing flush; call when the socket closes. */
  dispose: () => void;
};

/**
 * Turns the terminal socket's output stream into throttled
 * `TerminalOutputActivity` writes: the first chunk after a quiet spell
 * flushes at once, further chunks inside the throttle window accumulate and
 * flush once the window ends (a trailing write, so the last burst is never
 * lost). Bytes are counted as UTF-16 code units — a throughput hint, not an
 * accounting.
 */
export function createOutputActivityTracker(
  write: (activity: TerminalOutputActivity) => void,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
    fn,
    ms
  ) => setTimeout(fn, ms),
  cancel: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout
): OutputActivityTracker {
  let windowStart = 0;
  let bytesInWindow = 0;
  let lastWriteAt = -Infinity;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    pending = null;
    const at = now();
    const elapsed = Math.max(at - windowStart, 1);
    write({
      lastOutputAt: at,
      bytesPerSecond: Math.round((bytesInWindow * 1000) / elapsed),
    });
    lastWriteAt = at;
    windowStart = at;
    bytesInWindow = 0;
  };

  return {
    note: (chunk) => {
      const at = now();
      if (bytesInWindow === 0) windowStart = at;
      bytesInWindow += chunk.length;
      if (pending !== null) return;
      const sinceLast = at - lastWriteAt;
      if (sinceLast >= OUTPUT_ACTIVITY_THROTTLE_MS) {
        flush();
        return;
      }
      pending = schedule(flush, OUTPUT_ACTIVITY_THROTTLE_MS - sinceLast);
    },
    dispose: () => {
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
