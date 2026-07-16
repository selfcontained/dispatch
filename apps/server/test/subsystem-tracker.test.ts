import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubsystemTracker } from "../src/observability/subsystem-tracker.js";

describe("SubsystemTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves from unknown through running to healthy", () => {
    const tracker = new SubsystemTracker({
      id: "reconcile",
      label: "Reconciliation",
      description: "Checks sessions",
      expectedCadenceMs: 30_000,
    });

    expect(tracker.snapshot().state).toBe("unknown");
    const run = tracker.start();
    expect(tracker.snapshot().state).toBe("running");
    vi.advanceTimersByTime(125);
    run.succeed({ corrections: 2 });

    expect(tracker.snapshot()).toMatchObject({
      state: "healthy",
      runs: 1,
      failures: 0,
      lastDurationMs: 125,
      metadata: { corrections: 2 },
    });
  });

  it("degrades on failure without exposing exception details", () => {
    const tracker = new SubsystemTracker({
      id: "git",
      label: "Git",
      description: "Refreshes diffs",
    });
    const run = tracker.start();
    run.fail(
      new Error(
        "git -C /Users/private/repo failed https://user:pass@example.test token=secret cookie=session"
      )
    );

    expect(tracker.snapshot()).toMatchObject({
      state: "degraded",
      statusReason: "failure",
      failures: 1,
      lastError: "Operation failed",
    });
  });

  it("uses a stable timeout summary for timeout-like failures", () => {
    const tracker = new SubsystemTracker({
      id: "db",
      label: "Database",
      description: "Checks connectivity",
    });
    tracker.start().fail(new Error("query timeout password=hunter2"));
    expect(tracker.snapshot().lastError).toBe("Operation timed out");
  });

  it("marks recurring work stale after twice its cadence", () => {
    const tracker = new SubsystemTracker({
      id: "loop",
      label: "Loop",
      description: "Recurring work",
      expectedCadenceMs: 1_000,
    });
    tracker.start().succeed();
    vi.advanceTimersByTime(2_001);
    expect(tracker.snapshot()).toMatchObject({
      state: "degraded",
      statusReason: "stale",
    });
  });

  it("degrades a recurring run that never settles", () => {
    const tracker = new SubsystemTracker({
      id: "loop",
      label: "Loop",
      description: "Recurring work",
      expectedCadenceMs: 1_000,
    });
    tracker.start();
    vi.advanceTimersByTime(2_001);
    expect(tracker.snapshot()).toMatchObject({
      state: "degraded",
      statusReason: "stuck",
      inFlight: 1,
    });
  });

  it("reports intentionally disabled work without degrading it", () => {
    const tracker = new SubsystemTracker({
      id: "updates",
      label: "Updates",
      description: "Checks releases",
      expectedCadenceMs: 1_000,
    });
    tracker.setDisabled(true);
    expect(tracker.snapshot().state).toBe("disabled");
  });
});
