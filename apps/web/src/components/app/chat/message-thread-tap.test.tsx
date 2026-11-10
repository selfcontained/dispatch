// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, beforeAll, expect, it, vi } from "vitest";
import { MessageThreadTap } from "./message-thread-tap";
beforeAll(() => {
  class Pointer extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = Pointer as typeof PointerEvent;
});
let phone = true;
beforeEach(() => {
  phone = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: phone }))
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
it("does not open on larger screens", () => {
  phone = false;
  const { open, target } = setup();
  down(target);
  release(target);
  expect(open).not.toHaveBeenCalled();
});
it("cancels a phone gesture if the viewport grows before click", () => {
  const { open, target } = setup();
  down(target);
  phone = false;
  release(target);
  expect(open).not.toHaveBeenCalled();
});
