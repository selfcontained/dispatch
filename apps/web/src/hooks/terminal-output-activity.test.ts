import { describe, expect, it } from "vitest";

import {
  OUTPUT_ACTIVITY_THROTTLE_MS,
  createOutputActivityTracker,
} from "./terminal-output-activity";

function harness(start = 10_000) {
  let now = start;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const writes: Array<{ lastOutputAt: number; bytesPerSecond: number }> = [];
  const tracker = createOutputActivityTracker(
    (activity) => writes.push(activity),
    () => now,
    (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    (handle) => {
      const idx = timers.findIndex((t) => t.id === (handle as unknown));
      if (idx !== -1) timers.splice(idx, 1);
    }
  );
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.slice()) {
      if (timer.at <= now) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    }
  };
  return { tracker, writes, advance, timers };
}

describe("createOutputActivityTracker", () => {
  it("writes the first chunk at once and coalesces the rest of the window", () => {
    const { tracker, writes, advance } = harness();
    tracker.note("abcd");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.lastOutputAt).toBe(10_000);

    tracker.note("ef");
    tracker.note("gh");
    expect(writes).toHaveLength(1);
    advance(OUTPUT_ACTIVITY_THROTTLE_MS);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.lastOutputAt).toBe(10_000 + OUTPUT_ACTIVITY_THROTTLE_MS);
    expect(writes[1]!.bytesPerSecond).toBe(16); // 4 chars over 250 ms
  });

  it("never exceeds four writes a second under a steady stream", () => {
    const { tracker, writes, advance } = harness();
    for (let i = 0; i < 100; i += 1) {
      tracker.note("x");
      advance(10);
    }
    // One leading write plus one per throttle window over ~1 s.
    expect(writes.length).toBeLessThanOrEqual(5);
    expect(writes.length).toBeGreaterThanOrEqual(4);
  });

  it("drops a pending flush on dispose", () => {
    const { tracker, writes, advance, timers } = harness();
    tracker.note("a");
    tracker.note("b");
    expect(timers).toHaveLength(1);
    tracker.dispose();
    expect(timers).toHaveLength(0);
    advance(1_000);
    expect(writes).toHaveLength(1);
  });
});
