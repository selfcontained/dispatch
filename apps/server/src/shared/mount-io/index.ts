import { MountIO } from "./mount-io.js";

export { Semaphore } from "./semaphore.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export type { BreakerState } from "./circuit-breaker.js";
export { MountIO, MountStallError, MountUnavailableError } from "./mount-io.js";
export type { MountIOConfig } from "./mount-io.js";

const num = (raw: string | undefined, fallback: number): number => {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Process-wide singleton. The breaker and semaphore are global (not keyed by
// label), which assumes every caller reads the SAME mount — true today: both
// token-harvester sources (~/.claude/projects and ~/.codex/sessions) live under
// the home dir on the same gcsfuse mount, so a shared breaker is desirable (it
// avoids hammering a stalled mount from multiple sources). If a future caller
// reads a *different* mount root, key the breaker/semaphore by mount root (the
// `label` prefix passed to run() is the natural seam) so a stall in one mount
// does not suppress I/O against a healthy one.
//
// Default timeout is deliberately lenient (10s): harvesting is a periodic
// background task, and a healthy-but-slow mount (cold metadata cache, large
// readdir, transient GCS latency) can momentarily exceed a tight client
// timeout. A lenient timeout trades a little stall-detection latency for far
// fewer false breaker trips. Operators on high-latency mounts can raise it
// further via DISPATCH_MOUNT_IO_TIMEOUT_MS.
export const mountIO = new MountIO({
  timeoutMs: num(process.env.DISPATCH_MOUNT_IO_TIMEOUT_MS, 10_000),
  maxConcurrency: num(process.env.DISPATCH_MOUNT_IO_CONCURRENCY, 2),
  breakerThreshold: num(process.env.DISPATCH_MOUNT_IO_BREAKER_THRESHOLD, 3),
  breakerCooldownMs: num(
    process.env.DISPATCH_MOUNT_IO_BREAKER_COOLDOWN_MS,
    60_000
  ),
});
