// @vitest-environment jsdom
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAWER_EDGE_GUTTER_PX,
  DRAWER_PINNED_CENTRE_MIN_PX,
  DRAWER_SETTLE_FALLBACK_MS,
  drawerPinnedReserve,
} from "./drawer-constants";

const STORAGE_KEY = "dispatch:drawerWidth";

// The width atom reads storage once, when store.ts is first imported, so
// each test imports a fresh copy after it has set storage up.
async function loadFrame() {
  vi.resetModules();
  const { DrawerFrame } = await import("./drawer");
  return DrawerFrame;
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function frameWidth(testId = "drawer-wrapper"): number {
  return parseFloat(screen.getByTestId(testId).style.width);
}

function transitionEnd(element: HTMLElement, propertyName = "width") {
  const event = createEvent.transitionEnd(element);
  Object.defineProperty(event, "propertyName", { value: propertyName });
  fireEvent(element, event);
}

function drag(handle: HTMLElement, fromX: number, toX: number) {
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: fromX,
  });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: toX });
}

function release(handle: HTMLElement, x: number) {
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: x });
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(1600);
});

afterEach(() => {
  cleanup();
});

describe("DrawerFrame resize", () => {
  it.each([true, false])(
    "widens as its left edge is dragged left (pinned: %s), and keeps the width across a remount",
    async (pinned) => {
      const DrawerFrame = await loadFrame();
      const view = render(
        <DrawerFrame open pinned={pinned}>
          <div />
        </DrawerFrame>
      );
      expect(frameWidth()).toBe(400);

      const handle = screen.getByTestId("drawer-resize-handle");
      drag(handle, 1200, 1050);
      expect(frameWidth()).toBe(550);
      // Mid-drag the width is the frame's own; it is written on release.
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      release(handle, 1050);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("550");

      view.unmount();
      render(
        <DrawerFrame open pinned={pinned}>
          <div />
        </DrawerFrame>
      );
      expect(frameWidth()).toBe(550);
    }
  );

  it("reads a stored width back from storage on load", async () => {
    window.localStorage.setItem(STORAGE_KEY, "600");
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned>
        <div />
      </DrawerFrame>
    );
    expect(frameWidth()).toBe(600);
  });

  it("is one width for every frame, not one per drawer", async () => {
    const DrawerFrame = await loadFrame();
    render(
      <>
        <DrawerFrame open pinned testId="thread-drawer-wrapper">
          <div />
        </DrawerFrame>
        <DrawerFrame open={false} pinned>
          <div />
        </DrawerFrame>
      </>
    );
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1100);
    release(handle, 1100);
    expect(frameWidth("thread-drawer-wrapper")).toBe(500);
    // The closed frame is 0 wide; its content is laid out at the new width.
    const closed = screen.getByTestId("drawer-wrapper");
    expect(closed.style.width).toBe("0px");
    expect((closed.lastElementChild as HTMLElement).style.width).toBe("500px");
  });

  it("floating, drags past the old cap to all but the edge gutter, and the handle still works there", async () => {
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned={false}>
        <div />
      </DrawerFrame>
    );
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1500);
    expect(frameWidth()).toBe(320);
    // The old cap was 1600 - 720 = 880; this keeps going.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 });
    expect(frameWidth()).toBe(1300);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -2000 });
    // All but the 48 gutter, so the left edge (and its handle) sits at 48.
    expect(frameWidth()).toBe(1600 - DRAWER_EDGE_GUTTER_PX);
    release(handle, -2000);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1552");

    // Still there and operable by keyboard at the maximum.
    expect(handle.isConnected).toBe(true);
    expect(handle.getAttribute("aria-valuemax")).toBe("1552");
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(frameWidth()).toBe(1536);
    fireEvent.keyDown(handle, { key: "End" });
    expect(frameWidth()).toBe(1552);
  });

  it("pinned, leaves the centre 320 and the left sidebar when it is open", async () => {
    expect(DRAWER_PINNED_CENTRE_MIN_PX).toBe(320);
    expect(drawerPinnedReserve(true)).toBe(640);
    expect(drawerPinnedReserve(false)).toBe(320);
    const DrawerFrame = await loadFrame();
    const frame = (reserve: number) => (
      <DrawerFrame open pinned pinnedReserve={reserve}>
        <div />
      </DrawerFrame>
    );
    const view = render(frame(drawerPinnedReserve(true)));
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, -2000);
    expect(frameWidth()).toBe(960);
    release(handle, -2000);
    expect(handle.getAttribute("aria-valuemax")).toBe("960");

    // Left sidebar collapsed: the centre alone keeps its 320.
    view.rerender(frame(drawerPinnedReserve(false)));
    fireEvent.keyDown(handle, { key: "End" });
    expect(frameWidth()).toBe(1280);
    // Opening it again clamps the same stored width back, on read.
    view.rerender(frame(drawerPinnedReserve(true)));
    expect(frameWidth()).toBe(960);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1280");
  });

  it("clamps a stored width wider than this viewport allows, without losing it", async () => {
    window.localStorage.setItem(STORAGE_KEY, "5000");
    setViewportWidth(1000);
    const DrawerFrame = await loadFrame();
    const frame = (pinned: boolean) => (
      <DrawerFrame open pinned={pinned}>
        <div />
      </DrawerFrame>
    );
    const view = render(frame(false));
    expect(frameWidth()).toBe(1000 - DRAWER_EDGE_GUTTER_PX);
    // Pinned, 1000 - 640 is under the default, so the default is the ceiling.
    view.rerender(frame(true));
    expect(frameWidth()).toBe(400);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("5000");

    act(() => {
      setViewportWidth(1600);
      window.dispatchEvent(new Event("resize"));
    });
    expect(frameWidth()).toBe(960);
    view.rerender(frame(false));
    expect(frameWidth()).toBe(1552);
  });

  it("clamps a stored width under the minimum, and ignores one that is not a number", async () => {
    window.localStorage.setItem(STORAGE_KEY, "40");
    let DrawerFrame = await loadFrame();
    const view = render(
      <DrawerFrame open pinned>
        <div />
      </DrawerFrame>
    );
    expect(frameWidth()).toBe(320);
    view.unmount();

    window.localStorage.setItem(STORAGE_KEY, '"wide"');
    DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned>
        <div />
      </DrawerFrame>
    );
    expect(frameWidth()).toBe(400);
  });

  it("steps with the arrow keys from a focusable handle", async () => {
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned>
        <div />
      </DrawerFrame>
    );
    const handle = screen.getByRole("separator", { name: "Resize drawer" });
    handle.focus();
    expect(document.activeElement).toBe(handle);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(frameWidth()).toBe(416);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(frameWidth()).toBe(352);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(frameWidth()).toBe(320);
    fireEvent.keyDown(handle, { key: "End" });
    expect(frameWidth()).toBe(960);
    expect(handle.getAttribute("aria-valuenow")).toBe("960");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("960");
  });

  it("has no handle while closed", async () => {
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open={false} pinned>
        <div />
      </DrawerFrame>
    );
    expect(screen.queryByTestId("drawer-resize-handle")).toBeNull();
  });
});

describe("DrawerFrame closing", () => {
  async function loadClosingFrame() {
    vi.resetModules();
    const { DrawerFrame, useDrawerClosing } = await import("./drawer");
    function Probe() {
      return (
        <div data-testid="content" data-closing={String(useDrawerClosing())} />
      );
    }
    return (open: boolean, pinned = true) => (
      <DrawerFrame open={open} pinned={pinned}>
        <Probe />
      </DrawerFrame>
    );
  }
  const closing = () => screen.getByTestId("content").dataset.closing;

  it.each([
    [true, "width"],
    [false, "transform"],
  ])(
    "tells the content it is closing until the slide ends (pinned: %s)",
    async (pinned, property) => {
      const frame = await loadClosingFrame();
      const view = render(frame(true, pinned));
      expect(closing()).toBe("false");

      view.rerender(frame(false, pinned));
      expect(closing()).toBe("true");
      const wrapper = screen.getByTestId("drawer-wrapper");
      // Bubbled transitions from inside, and other properties, are not it.
      transitionEnd(screen.getByTestId("content"), property);
      transitionEnd(wrapper, "opacity");
      expect(closing()).toBe("true");
      transitionEnd(wrapper, property);
      expect(closing()).toBe("false");
    }
  );

  it("stops closing when it opens again mid-slide", async () => {
    const frame = await loadClosingFrame();
    const view = render(frame(true));
    view.rerender(frame(false));
    expect(closing()).toBe("true");
    view.rerender(frame(true));
    expect(closing()).toBe("false");
    // The reversed slide's end does not start a close.
    transitionEnd(screen.getByTestId("drawer-wrapper"));
    expect(closing()).toBe("false");
  });

  it("settles on a fallback when no transition ends", async () => {
    vi.useFakeTimers();
    try {
      const frame = await loadClosingFrame();
      const view = render(frame(true));
      view.rerender(frame(false));
      expect(closing()).toBe("true");
      act(() => {
        vi.advanceTimersByTime(DRAWER_SETTLE_FALLBACK_MS);
      });
      expect(closing()).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drags with the transition off, so a drag's end is never a close's", async () => {
    const frame = await loadClosingFrame();
    render(frame(true));
    const wrapper = screen.getByTestId("drawer-wrapper");
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1000);
    expect(wrapper.style.transitionDuration).toBe("0ms");
    expect(wrapper.dataset.resizing).toBe("true");
    release(handle, 1000);
    expect(wrapper.style.transitionDuration).toBe("300ms");
    // A keyboard step animates, and its end while open is not a close.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    transitionEnd(wrapper);
    expect(closing()).toBe("false");
  });
});
