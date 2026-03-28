import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { FocusTracker } from "../src/focus-tracker.js";

describe("FocusTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for an agent that was never focused", () => {
    const tracker = new FocusTracker();
    expect(tracker.isFocused("agent-1")).toBe(false);
  });

  it("returns true immediately after setFocused", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");
    expect(tracker.isFocused("agent-1")).toBe(true);
  });

  it("returns false after the TTL expires", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");

    vi.advanceTimersByTime(30_001);
    expect(tracker.isFocused("agent-1")).toBe(false);
  });

  it("returns true just before the TTL expires", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");

    vi.advanceTimersByTime(29_999);
    expect(tracker.isFocused("agent-1")).toBe(true);
  });

  it("clearFocused removes focus immediately", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");
    expect(tracker.isFocused("agent-1")).toBe(true);

    tracker.clearFocused("agent-1");
    expect(tracker.isFocused("agent-1")).toBe(false);
  });

  it("tracks multiple agents independently", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");
    tracker.setFocused("agent-2");

    expect(tracker.isFocused("agent-1")).toBe(true);
    expect(tracker.isFocused("agent-2")).toBe(true);

    tracker.clearFocused("agent-1");
    expect(tracker.isFocused("agent-1")).toBe(false);
    expect(tracker.isFocused("agent-2")).toBe(true);
  });

  it("refreshes TTL on repeated setFocused calls", () => {
    const tracker = new FocusTracker();
    tracker.setFocused("agent-1");

    vi.advanceTimersByTime(20_000);
    tracker.setFocused("agent-1"); // refresh

    vi.advanceTimersByTime(20_000); // 40s total, but only 20s since refresh
    expect(tracker.isFocused("agent-1")).toBe(true);

    vi.advanceTimersByTime(11_000); // 31s since last refresh
    expect(tracker.isFocused("agent-1")).toBe(false);
  });
});
