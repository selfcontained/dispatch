import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { TaskWatchNotifier } from "../src/tasks/watch-notifier.js";

describe("task watch scheduling", () => {
  let notifier: TaskWatchNotifier;
  const query = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    query.mockReset().mockImplementation(() => {
      throw new Error("Scheduler tests must not perform database I/O");
    });
    warn.mockReset();
    notifier = new TaskWatchNotifier({
      pool: { query } as unknown as Pool,
      projectForAgent: vi.fn(),
      deliver: vi.fn(),
      warn,
    });
    // Exercise the actual schedule/cancel/dispose implementation, but never
    // run asynchronous Postgres work while the clock is controlled.
    vi.spyOn(notifier, "flushTask").mockResolvedValue();
  });

  afterEach(() => {
    notifier.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(query).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flushes once at the default inactivity deadline", async () => {
    notifier.schedule("task");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(notifier.flushTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("task");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notifier.flushTask).toHaveBeenCalledTimes(1);
  });

  it("resets the deadline on activity, including repeated resets", async () => {
    notifier.schedule("task");
    await vi.advanceTimersByTimeAsync(2_000);
    notifier.schedule("task");
    await vi.advanceTimersByTimeAsync(2_000);
    notifier.schedule("task");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(notifier.flushTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("task");
  });

  it("keeps task deadlines independent when one task is rescheduled", async () => {
    notifier.schedule("first");
    notifier.schedule("second");
    await vi.advanceTimersByTimeAsync(1_000);
    notifier.schedule("first");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("second");
    await vi.advanceTimersByTimeAsync(999);
    expect(notifier.flushTask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(notifier.flushTask).mock.calls).toEqual([
      ["second"],
      ["first"],
    ]);
  });

  it("cancels only the requested task and permits scheduling it again", async () => {
    notifier.schedule("cancelled");
    notifier.schedule("other");
    await vi.advanceTimersByTimeAsync(1_000);
    notifier.cancel("cancelled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("other");
    notifier.schedule("cancelled");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(vi.mocked(notifier.flushTask).mock.calls).toEqual([
      ["other"],
      ["cancelled"],
    ]);
  });

  it("keeps the task wakeup when cancellation is scoped to one watcher", async () => {
    notifier.schedule("task");
    notifier.cancel("task", "watcher");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("task");
  });

  it("disposes every outstanding wakeup", async () => {
    notifier.schedule("first");
    await vi.advanceTimersByTimeAsync(1_000);
    notifier.schedule("second");
    notifier.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(notifier.flushTask).not.toHaveBeenCalled();
  });

  it("uses the configured debounce and reports failed automatic flushes", async () => {
    notifier.dispose();
    notifier = new TaskWatchNotifier({
      pool: { query } as unknown as Pool,
      projectForAgent: vi.fn(),
      deliver: vi.fn(),
      warn,
      debounceMs: 100,
    });
    const error = new Error("flush failed");
    vi.spyOn(notifier, "flushTask").mockRejectedValue(error);
    notifier.schedule("task");
    await vi.advanceTimersByTimeAsync(99);
    expect(notifier.flushTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notifier.flushTask).toHaveBeenCalledExactlyOnceWith("task");
    expect(warn).toHaveBeenCalledExactlyOnceWith(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
