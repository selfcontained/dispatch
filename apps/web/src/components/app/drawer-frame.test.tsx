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

  it("clamps a drag to the minimum and to what the viewport leaves", async () => {
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned>
        <div />
      </DrawerFrame>
    );
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1500);
    expect(frameWidth()).toBe(320);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -2000 });
    // 1600 wide: the centre keeps 720, so the drawer tops out at 880.
    expect(frameWidth()).toBe(880);
    release(handle, -2000);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("880");
  });

  it("clamps a stored width wider than this viewport allows, without losing it", async () => {
    window.localStorage.setItem(STORAGE_KEY, "5000");
    setViewportWidth(1000);
    const DrawerFrame = await loadFrame();
    render(
      <DrawerFrame open pinned={false}>
        <div />
      </DrawerFrame>
    );
    // 1000 - 720 is under the default, so the default is the ceiling.
    expect(frameWidth()).toBe(400);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("5000");

    act(() => {
      setViewportWidth(1600);
      window.dispatchEvent(new Event("resize"));
    });
    expect(frameWidth()).toBe(880);
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
    expect(frameWidth()).toBe(880);
    expect(handle.getAttribute("aria-valuenow")).toBe("880");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("880");
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

describe("DrawerFrame width transition", () => {
  it("reports the end of an open and of a close, and not of a resize", async () => {
    const DrawerFrame = await loadFrame();
    const onWidthTransitionEnd = vi.fn();
    const frame = (open: boolean) => (
      <DrawerFrame
        open={open}
        pinned
        onWidthTransitionEnd={onWidthTransitionEnd}
      >
        <div data-testid="content" />
      </DrawerFrame>
    );
    const view = render(frame(false));
    const wrapper = screen.getByTestId("drawer-wrapper");

    view.rerender(frame(true));
    transitionEnd(wrapper);
    expect(onWidthTransitionEnd).toHaveBeenCalledTimes(1);

    // A drag runs with the transition off and reports nothing.
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1000);
    expect(wrapper.style.transitionDuration).toBe("0ms");
    expect(wrapper.dataset.resizing).toBe("true");
    release(handle, 1000);
    expect(wrapper.style.transitionDuration).toBe("300ms");
    // A keyboard step animates, and its transitionend is not an open.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    transitionEnd(wrapper);
    expect(onWidthTransitionEnd).toHaveBeenCalledTimes(1);

    // Bubbled transitions from inside, and other properties, are not it.
    view.rerender(frame(false));
    transitionEnd(screen.getByTestId("content"));
    transitionEnd(wrapper, "opacity");
    expect(onWidthTransitionEnd).toHaveBeenCalledTimes(1);
    transitionEnd(wrapper);
    expect(onWidthTransitionEnd).toHaveBeenCalledTimes(2);
  });

  it("does not leave a drag that cut an open short to be reported later", async () => {
    const DrawerFrame = await loadFrame();
    const onWidthTransitionEnd = vi.fn();
    const frame = (open: boolean) => (
      <DrawerFrame
        open={open}
        pinned
        onWidthTransitionEnd={onWidthTransitionEnd}
      >
        <div />
      </DrawerFrame>
    );
    const view = render(frame(false));
    view.rerender(frame(true));
    const wrapper = screen.getByTestId("drawer-wrapper");
    const handle = screen.getByTestId("drawer-resize-handle");
    drag(handle, 1200, 1100);
    release(handle, 1100);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    transitionEnd(wrapper);
    expect(onWidthTransitionEnd).not.toHaveBeenCalled();
  });
});
