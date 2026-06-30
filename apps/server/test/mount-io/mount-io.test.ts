import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MountIO,
  MountStallError,
  MountUnavailableError,
} from "../../src/shared/mount-io/mount-io.js";

const cfg = {
  timeoutMs: 5000,
  maxConcurrency: 2,
  breakerThreshold: 2,
  breakerCooldownMs: 60_000,
};

describe("MountIO", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the result of a fast op", async () => {
    const io = new MountIO(cfg);
    await expect(io.run("ok", async () => 42)).resolves.toBe(42);
    expect(io.available()).toBe(true);
  });

  it("times out a hanging op and aborts its signal", async () => {
    const io = new MountIO(cfg);
    let aborted = false;
    const p = io.run("hang", (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return new Promise<never>(() => {});
    });
    const assertion = expect(p).rejects.toBeInstanceOf(MountStallError);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(aborted).toBe(true);
  });

  it("opens the breaker after threshold timeouts, then skips fn", async () => {
    const io = new MountIO(cfg);
    const hang = () => new Promise<never>(() => {});

    for (let i = 0; i < 2; i++) {
      const p = io.run(`hang-${i}`, hang);
      const a = expect(p).rejects.toBeInstanceOf(MountStallError);
      await vi.advanceTimersByTimeAsync(5001);
      await a;
    }

    expect(io.available()).toBe(false);
    let called = false;
    await expect(
      io.run("blocked", async () => {
        called = true;
        return 1;
      }),
    ).rejects.toBeInstanceOf(MountUnavailableError);
    expect(called).toBe(false);
  });

  it("never runs more than maxConcurrency fns at once", async () => {
    const io = new MountIO({ ...cfg, maxConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const starts = Array.from({ length: 5 }, (_, i) =>
      io.run(`c-${i}`, () => {
        active++;
        peak = Math.max(peak, active);
        return new Promise<number>((resolve) => {
          release.push(() => {
            active--;
            resolve(i);
          });
        });
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBeLessThanOrEqual(2);
    release.forEach((r) => r());
    await Promise.all(starts);
  });

  it("does not emit an unhandled rejection when fn rejects after timeout", async () => {
    const io = new MountIO(cfg);
    const p = io.run(
      "late-reject",
      () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("late")), 10_000),
        ),
    );
    const a = expect(p).rejects.toBeInstanceOf(MountStallError);
    await vi.advanceTimersByTimeAsync(5001);
    await a;
    await vi.advanceTimersByTimeAsync(6000);
  });
});
