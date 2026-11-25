// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearWindowedRowHeights,
  useWindowedRows,
  WindowGap,
} from "./windowed-rows";

/** ResizeObservers made by the hook, so a test can report a row's size. */
const observers: Array<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}> = [];

class StubResizeObserver {
  private entry: { callback: ResizeObserverCallback; targets: Set<Element> };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set() };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.add(el);
  }
  unobserve(el: Element) {
    this.entry.targets.delete(el);
  }
  disconnect() {
    this.entry.targets.clear();
  }
}

/** Report `el` at `height` to every observer watching it. */
function resize(el: Element, height: number) {
  for (const { callback, targets } of observers) {
    if (!targets.has(el)) continue;
    callback(
      [
        {
          target: el,
          borderBoxSize: [{ blockSize: height, inlineSize: 300 }],
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver
    );
  }
}

function List({ keys }: { keys: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const windowed = useWindowedRows({
    scrollRef,
    keys,
    align: "end",
    cacheKey: "floor-test",
  });
  return (
    <div ref={scrollRef} data-testid="scroller">
      <div
        ref={windowed.containerRef}
        {...windowed.containerProps}
        data-testid="list"
      >
        {windowed.segments.flatMap((segment) =>
          segment.kind === "gap"
            ? [<WindowGap key={segment.key} height={segment.height} />]
            : keys.slice(segment.from, segment.to).map((key) => (
                <div key={key} ref={windowed.measure(key)} data-row={key}>
                  {key}
                </div>
              ))
        )}
      </div>
    </div>
  );
}

describe("useWindowedRows floor", () => {
  beforeEach(() => {
    observers.length = 0;
    clearWindowedRowHeights();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the list at least as tall as its rows add up to", () => {
    const keys = ["a", "b", "c"];
    const { getByTestId, container } = render(<List keys={keys} />);
    const list = getByTestId("list");
    // Unmeasured rows count at the default estimate.
    expect(list.style.minHeight).toBe("360px");

    const row = (key: string) =>
      container.querySelector(`[data-row="${key}"]`)!;
    act(() => {
      resize(row("a"), 50);
      resize(row("b"), 400);
    });
    // Measured heights replace the estimate as soon as they are known, so
    // a swap of rows for a spacer in the next commit cannot dip below them.
    expect(list.style.minHeight).toBe("570px");

    // Rows that really are shorter bring the floor down.
    act(() => resize(row("b"), 100));
    expect(list.style.minHeight).toBe("270px");
  });

  it("follows the rows the list has, not the ones it had", () => {
    const { getByTestId, rerender } = render(<List keys={["a", "b", "c"]} />);
    rerender(<List keys={["a", "b"]} />);
    expect(getByTestId("list").style.minHeight).toBe("240px");
  });
});
