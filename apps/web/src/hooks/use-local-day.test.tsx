// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocalDay } from "./use-local-day";
import { sidebarScheduleTime } from "@/components/app/scheduled-messages";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shared local day clock", () => {
  it("shares one midnight timer, updates mounted wording, and cleans up the last subscriber", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 23, 59, 59));
    const due = new Date(2026, 9, 16, 8, 45).toISOString();
    const dueToday = new Date(2026, 9, 15, 20, 45).toISOString();
    const first = renderHook(() => {
      const today = useLocalDay();
      return {
        tomorrow: sidebarScheduleTime(due, today),
        earlier: sidebarScheduleTime(dueToday, today),
      };
    });
    const second = renderHook(() => useLocalDay());
    expect(first.result.current.tomorrow).toMatch(/Oct 16 at/);
    expect(first.result.current.earlier).not.toContain(" at ");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(first.result.current.tomorrow).toBe(
      new Date(due).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    );
    expect(first.result.current.earlier).toMatch(/Oct 15 at/);
    expect(second.result.current.getDate()).toBe(16);
    expect(vi.getTimerCount()).toBe(1);
    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["focus", "visibilitychange"])(
    "catches up on %s after the clock skips a day",
    (event) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 15, 8));
      const hook = renderHook(() => useLocalDay());
      act(() => {
        vi.setSystemTime(new Date(2026, 9, 16, 9));
        (event === "focus" ? window : document).dispatchEvent(new Event(event));
      });
      expect(hook.result.current.getDate()).toBe(16);
      expect(vi.getTimerCount()).toBe(1);
    }
  );
});
