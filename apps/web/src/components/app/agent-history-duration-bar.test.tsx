// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DurationBar } from "./agent-history-duration-bar";

// recharts' ResponsiveContainer observes its parent size and jsdom has no
// ResizeObserver. The stub reports a real size synchronously so the chart
// actually lays out its bars instead of rendering an empty 0x0 wrapper.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 400, height: 32 },
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DurationBar", () => {
  it("renders nothing when the durations sum to zero", () => {
    const zeroed = render(
      <DurationBar durations={{ working: 0, blocked: 0, waiting_user: 0 }} />
    );
    expect(zeroed.container.firstChild).toBeNull();

    const empty = render(<DurationBar durations={{}} />);
    expect(empty.container.firstChild).toBeNull();
  });

  it("renders all three stacked series when durations are non-zero", () => {
    const { container } = render(
      <DurationBar
        durations={{ working: 120_000, blocked: 30_000, waiting_user: 15_000 }}
      />
    );
    expect(container.querySelector("[data-chart]")).toBeTruthy();
    // One bar layer per status series — a dropped or renamed dataKey would
    // lose its layer. The per-series VALUES are not asserted: recharts
    // animates the rect paths in, and jsdom never paints an animation frame,
    // so the rectangles stay empty regardless of the data fed to them.
    expect(container.querySelectorAll(".recharts-bar")).toHaveLength(3);
  });
});
