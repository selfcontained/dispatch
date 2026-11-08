// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MessageThreadTap } from "./message-thread-tap";
beforeAll(() => {
  class Pointer extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = Pointer as typeof PointerEvent;
});
beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: vi.fn(() => []),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function setup() {
  const open = vi.fn();
  render(
    <MessageThreadTap onOpen={open}>
      <p>Message content</p>
      <button>Copy</button>
      <a href="#link">Link</a>
      <pre>Code</pre>
    </MessageThreadTap>
  );
  return { open, target: screen.getByText("Message content") };
}
function down(target: Element) {
  fireEvent.pointerDown(target, { clientX: 20, clientY: 20 });
}
function release(target: Element) {
  fireEvent.pointerUp(target, { clientX: 20, clientY: 20 });
  fireEvent.click(target);
}
it("opens a short primary tap once", () => {
  const { open, target } = setup();
  down(target);
  release(target);
  expect(open).toHaveBeenCalledTimes(1);
});
it.each(["move", "cancel", "leave", "drag", "hold", "multi", "selection"])(
  "rejects %s and its release click",
  (kind) => {
    const { open, target } = setup();
    down(target);
    if (kind === "move")
      fireEvent.pointerMove(target, { clientX: 40, clientY: 20 });
    if (kind === "cancel") fireEvent.pointerCancel(target);
    if (kind === "leave") fireEvent.pointerLeave(target);
    if (kind === "drag") fireEvent.dragStart(target);
    if (kind === "hold")
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600);
    if (kind === "multi") fireEvent.touchStart(target, { touches: [{}, {}] });
    if (kind === "selection") {
      const range = document.createRange();
      range.selectNodeContents(target);
      window.getSelection()?.addRange(range);
    }
    release(target);
    expect(open).not.toHaveBeenCalled();
  }
);
it.each(["Copy", "Link", "Code"])("preserves nested %s", (text) => {
  const { open } = setup();
  const target = screen.getByText(text);
  down(target);
  release(target);
  expect(open).not.toHaveBeenCalled();
});
it("ignores clicks without a classified pointer gesture", () => {
  const { open, target } = setup();
  fireEvent.click(target);
  expect(open).not.toHaveBeenCalled();
});
it("accepts touch pointer-leave after release", () => {
  const { open, target } = setup();
  down(target);
  fireEvent.pointerUp(target, { clientX: 20, clientY: 20 });
  fireEvent.pointerLeave(target);
  fireEvent.click(target);
  expect(open).toHaveBeenCalledTimes(1);
});

it.each(["hold", "move", "cancel", "scroll", "multi", "drag", "release"])(
  "touch long press: %s",
  (kind) => {
    vi.useFakeTimers();
    const long = vi.fn();
    const open = vi.fn();
    render(
      <MessageThreadTap onOpen={open} onLongPress={long}>
        <p>Hold here</p>
      </MessageThreadTap>
    );
    const target = screen.getByText("Hold here");
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    if (kind === "move")
      fireEvent.pointerMove(target, { clientX: 40, clientY: 20 });
    if (kind === "cancel") fireEvent.pointerCancel(target);
    if (kind === "scroll") fireEvent.scroll(document);
    if (kind === "multi") fireEvent.touchStart(target, { touches: [{}, {}] });
    if (kind === "drag") fireEvent.dragStart(target);
    if (kind === "release") release(target);
    vi.advanceTimersByTime(500);
    expect(long).toHaveBeenCalledTimes(kind === "hold" ? 1 : 0);
    if (kind === "hold") {
      release(target);
      expect(open).not.toHaveBeenCalled();
      expect(long).toHaveBeenCalledWith({ x: 20, y: 20 });
    }
  }
);

it("preserves taps across collapsed caret selection changes", () => {
  const { open, target } = setup();
  down(target);
  fireEvent(document, new Event("selectionchange"));
  release(target);
  expect(open).toHaveBeenCalledTimes(1);
});
it("cancels touch holds when text becomes selected", () => {
  vi.useFakeTimers();
  const long = vi.fn();
  render(
    <MessageThreadTap onLongPress={long}>
      <p>Select here</p>
    </MessageThreadTap>
  );
  const target = screen.getByText("Select here");
  fireEvent.pointerDown(target, { pointerType: "touch" });
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  vi.advanceTimersByTime(600);
  expect(long).not.toHaveBeenCalled();
});

it.each([true, false])(
  "text-hit %s preserves native context behavior",
  (overText) => {
    vi.useFakeTimers();
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      { left: 10, right: 100, top: 10, bottom: 30 },
    ] as unknown as DOMRectList);
    const long = vi.fn();
    render(
      <MessageThreadTap onLongPress={long}>
        <p>Selectable words</p>
      </MessageThreadTap>
    );
    const target = screen.getByText("Selectable words");
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      clientX: overText ? 20 : 120,
      clientY: 20,
    });
    vi.advanceTimersByTime(600);
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(!overText);
    expect(long).toHaveBeenCalledTimes(overText ? 0 : 1);
  }
);
