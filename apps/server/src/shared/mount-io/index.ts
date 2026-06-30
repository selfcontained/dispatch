import { MountIO } from "./mount-io.js";

export { Semaphore } from "./semaphore.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export type { BreakerState } from "./circuit-breaker.js";
export {
  MountIO,
  MountStallError,
  MountUnavailableError,
} from "./mount-io.js";
export type { MountIOConfig } from "./mount-io.js";

const num = (raw: string | undefined, fallback: number): number => {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const mountIO = new MountIO({
  timeoutMs: num(process.env.DISPATCH_MOUNT_IO_TIMEOUT_MS, 5_000),
  maxConcurrency: num(process.env.DISPATCH_MOUNT_IO_CONCURRENCY, 2),
  breakerThreshold: num(process.env.DISPATCH_MOUNT_IO_BREAKER_THRESHOLD, 3),
  breakerCooldownMs: num(process.env.DISPATCH_MOUNT_IO_BREAKER_COOLDOWN_MS, 60_000),
});
