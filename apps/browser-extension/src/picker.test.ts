// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserSelection } from "./types";

const sendMessage = vi.fn<(message: unknown) => Promise<void>>();

describe("element picker click handling", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    sendMessage.mockReset();
    sendMessage.mockResolvedValue();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
    });
  });

  afterEach(() => {
    window.__dispatchElementPickerCleanup?.();
    vi.unstubAllGlobals();
  });

  it("captures the clicked element even when the last hover target is stale", async () => {
    document.body.innerHTML = `
      <button id="hovered">Hovered first</button>
      <button id="clicked">Actually clicked</button>`;
    const hovered = document.querySelector("#hovered") as HTMLButtonElement;
    const clicked = document.querySelector("#clicked") as HTMLButtonElement;

    await import("./picker");
    hovered.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    clicked.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0]?.[0] as {
      type: string;
      selection: BrowserSelection;
    };
    expect(message.type).toBe("picker:selected");
    expect(message.selection.element.selector).toBe("#clicked");
  });

  it("captures before an earlier document listener can consume the click", async () => {
    document.body.innerHTML = '<a id="target" href="/away">Select me</a>';
    const target = document.querySelector("#target") as HTMLAnchorElement;
    const pageCaptureListener = vi.fn((event: Event) => {
      event.stopImmediatePropagation();
    });
    document.addEventListener("click", pageCaptureListener, true);

    await import("./picker");
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "picker:selected" })
    );
    expect(pageCaptureListener).not.toHaveBeenCalled();
    document.removeEventListener("click", pageCaptureListener, true);
  });
});
