import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STREAM_WRITE_BATCH_MS,
  STREAM_WRITE_INTERVAL_MS,
  StreamWriteThrottle,
} from "../src/agents/stream-write-throttle.js";

describe("StreamWriteThrottle", () => {
  let fired: Array<[number, string]>;
  let throttle: StreamWriteThrottle;
  let start: number;

  beforeEach(() => {
    vi.useFakeTimers();
    start = Date.now();
    fired = [];
    throttle = new StreamWriteThrottle((agentId) =>
      fired.push([Date.now() - start, agentId])
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells the first write after the batching pause, then at most once per interval", () => {
    // A burst of steps: a write every 20ms for three seconds.
    for (let t = 0; t < 3_000; t += 20) {
      throttle.write("a", false);
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS);
    const times = fired.map(([t]) => t);
    expect(times[0]).toBe(STREAM_WRITE_BATCH_MS);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(
        STREAM_WRITE_INTERVAL_MS
      );
    }
    // Every write was covered: the last one was told within an interval.
    expect(times.at(-1)).toBeGreaterThanOrEqual(3_000 - 20);
    expect(times.length).toBeLessThanOrEqual(4);
  });

  it("paces each agent on its own", () => {
    throttle.write("a", false);
    vi.advanceTimersByTime(STREAM_WRITE_BATCH_MS);
    throttle.write("a", false);
    throttle.write("b", false);
    vi.advanceTimersByTime(STREAM_WRITE_BATCH_MS);
    // b's first write went after the pause; a's second waits out a's interval.
    expect(fired).toEqual([
      [STREAM_WRITE_BATCH_MS, "a"],
      [2 * STREAM_WRITE_BATCH_MS, "b"],
    ]);
    vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS);
    expect(fired.at(-1)).toEqual([
      STREAM_WRITE_BATCH_MS + STREAM_WRITE_INTERVAL_MS,
      "a",
    ]);
  });

  it("tells a settle at once and drops the write waiting behind it", () => {
    throttle.write("a", false);
    vi.advanceTimersByTime(STREAM_WRITE_BATCH_MS);
    // A step lands, then the turn settles while that step waits its turn.
    throttle.write("a", false);
    vi.advanceTimersByTime(200);
    throttle.write("a", true);
    expect(fired).toEqual([
      [STREAM_WRITE_BATCH_MS, "a"],
      [STREAM_WRITE_BATCH_MS + 200, "a"],
    ]);
    // Nothing older follows the final snapshot.
    vi.advanceTimersByTime(5 * STREAM_WRITE_INTERVAL_MS);
    expect(fired).toHaveLength(2);
  });

  it("paces writes after an immediate one from that moment", () => {
    throttle.write("a", true);
    throttle.write("a", false);
    vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS - 1);
    expect(fired).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([
      [0, "a"],
      [STREAM_WRITE_INTERVAL_MS, "a"],
    ]);
  });

  it("keeps pacing state only for agents told within the interval", () => {
    for (const id of ["a", "b", "c"]) throttle.write(id, true);
    expect(throttle.pacedCount()).toBe(3);
    vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS);
    throttle.write("d", true);
    expect(throttle.pacedCount()).toBe(1);
  });

  it("stays paced after a listener throws", () => {
    let calls = 0;
    const throwing = new StreamWriteThrottle(() => {
      calls += 1;
      throw new Error("listener failed");
    });
    expect(() => throwing.write("a", true)).toThrow("listener failed");
    throwing.write("a", false);
    vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS - 1);
    expect(calls).toBe(1);
    expect(() => vi.advanceTimersByTime(1)).toThrow("listener failed");
    expect(calls).toBe(2);
    throwing.write("a", false);
    expect(() => vi.advanceTimersByTime(STREAM_WRITE_INTERVAL_MS)).toThrow();
    expect(calls).toBe(3);
  });
});
