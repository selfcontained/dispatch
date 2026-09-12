// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoHeight } from "./auto-height";

// jsdom lays nothing out, so the observer stands in for the browser: each
// instance is kept so a test can report a new size the way a real resize
// would.
const observers: Array<{
  callback: ResizeObserverCallback;
  target: Element | null;
  disconnected: boolean;
}> = [];

function report(height: number): void {
  for (const observer of observers) {
    if (!observer.target || observer.disconnected) continue;
    observer.callback(
      [
        {
          target: observer.target,
          contentRect: { width: 300, height },
          borderBoxSize: [{ blockSize: height, inlineSize: 300 }],
        } as unknown as ResizeObserverEntry,
      ],
      observer as unknown as ResizeObserver
    );
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, target: null, disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.target = target;
      }
      unobserve(): void {}
      disconnect(): void {
        this.record.disconnected = true;
      }
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutoHeight", () => {
  it("renders its children inside a wrapper that follows their measured height", async () => {
    const view = render(
      <MotionConfig reducedMotion="always">
        <AutoHeight data-testid="wrap">
          <p>a row</p>
        </AutoHeight>
      </MotionConfig>
    );
    const wrap = view.getByTestId("wrap");
    expect(wrap.textContent).toBe("a row");
    expect(observers).toHaveLength(1);
    // The observed node is the content, not the wrapper: the wrapper's own
    // height is the one being driven, so watching it would feed back.
    expect(observers[0]!.target).not.toBe(wrap);
    expect(wrap.contains(observers[0]!.target)).toBe(true);

    report(120);
    await waitFor(() => expect(wrap.style.height).toBe("120px"));
    report(64);
    await waitFor(() => expect(wrap.style.height).toBe("64px"));
  });

  it("stops observing when unmounted", () => {
    const view = render(
      <MotionConfig reducedMotion="always">
        <AutoHeight>
          <p>a row</p>
        </AutoHeight>
      </MotionConfig>
    );
    view.unmount();
    expect(observers[0]!.disconnected).toBe(true);
  });

  it("lets the content size itself where the browser has no ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = render(
      <MotionConfig reducedMotion="always">
        <AutoHeight data-testid="wrap">
          <p>a row</p>
        </AutoHeight>
      </MotionConfig>
    );
    // Nothing measured, so nothing pinned: `auto` and unset both leave the
    // content in charge of the height.
    expect(["", "auto"]).toContain(view.getByTestId("wrap").style.height);
  });
});
