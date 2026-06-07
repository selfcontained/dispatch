import type { Terminal as XTerm } from "@xterm/xterm";
import type { MutableRefObject } from "react";

/** Strip terminal line-wrap artifacts from copied text. */
function cleanCopiedText(text: string): string {
  const joined = text.replace(/[ \t]*\r?\n[ \t]*/g, "");
  if (
    /^https?:\/\//.test(joined) ||
    (/\S/.test(joined) && !joined.includes(" "))
  ) {
    return joined;
  }
  return text;
}

/**
 * Register copy, paste, and clipboard-image-sync handlers on the terminal host.
 * Returns a cleanup function that removes all listeners.
 */
export function setupClipboardHandlers(
  host: HTMLDivElement,
  term: XTerm,
  wsRef: MutableRefObject<WebSocket | null>
): () => void {
  const handleCopy = (e: ClipboardEvent) => {
    if (term.hasSelection()) {
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData(
        "text/plain",
        cleanCopiedText(term.getSelection())
      );
    }
  };
  host.addEventListener("copy", handleCopy, true);

  const syncClipboardImage = (blob: File): void => {
    const form = new FormData();
    form.append(
      "file",
      blob,
      `clipboard.${blob.type === "image/png" ? "png" : "jpg"}`
    );
    fetch("/api/v1/clipboard/image", {
      method: "POST",
      body: form,
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`clipboard upload: ${res.status}`);
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: "\x16" }));
        }
      })
      .catch((err) => console.warn("Clipboard image paste failed:", err));
  };

  const handlePaste = (e: ClipboardEvent) => {
    const imageItem = Array.from(e.clipboardData?.items ?? []).find((item) =>
      item.type.startsWith("image/")
    );
    if (!imageItem) return;
    const blob = imageItem.getAsFile();
    if (!blob) return;
    e.preventDefault();
    e.stopPropagation();
    syncClipboardImage(blob);
  };
  host.addEventListener("paste", handlePaste, true);

  return () => {
    host.removeEventListener("copy", handleCopy, true);
    host.removeEventListener("paste", handlePaste, true);
  };
}

/**
 * Register touch-scroll and mousedown-synthesis handlers for mobile terminals.
 * Returns a cleanup function that removes all listeners.
 */
export function setupTouchHandlers(
  host: HTMLDivElement,
  screenEl: HTMLElement | null,
  noteScrollInteractionRef: MutableRefObject<() => void>
): () => void {
  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

  let touchY = 0;
  let touchAccum = 0;
  const TOUCH_SCROLL_SENSITIVITY_PX = 30;

  // ⚠️ CRITICAL — DO NOT add a copyModeAssistEnabled (or similar)
  // gate to these touch handlers. Tmux scroll on mobile is critical
  // functionality and is independent of the assist toggle.
  //
  // xterm has no native touch handling, so this synthesis is the ONLY
  // path that makes touch scroll work at all. tmux mouse mode is
  // enabled unconditionally at session launch (see
  // apps/server/src/agents/tmux/runtime.ts), so the synthetic wheel
  // events are forwarded to tmux as SGR mouse codes regardless of the
  // toggle. The toggle controls *only* the banner UI / the passive
  // copy-mode observer. PR #459 originally tied this synthesis to the
  // toggle and silently killed scroll for everyone with the toggle
  // off — do not repeat that mistake.
  const onTouchStart = (e: TouchEvent) => {
    if (!isTouchDevice || e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    touchAccum = 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!isTouchDevice || e.touches.length !== 1) return;
    if (!screenEl) return;
    const currentY = e.touches[0].clientY;
    const delta = touchY - currentY;
    touchY = currentY;
    touchAccum += delta;
    while (Math.abs(touchAccum) >= TOUCH_SCROLL_SENSITIVITY_PX) {
      const direction = touchAccum > 0 ? 1 : -1;
      touchAccum -= direction * TOUCH_SCROLL_SENSITIVITY_PX;
      screenEl.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: direction * 100,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  };

  // On touch devices, xterm's text-selection mousedown handler doesn't
  // fire from a real touch tap. Re-dispatch with shift+alt set so xterm
  // treats the tap as the start of a selection, which in turn focuses
  // the screen so subsequent input events route correctly.
  let dispatchingMouseDown = false;
  const onMouseDown = (e: MouseEvent) => {
    if (dispatchingMouseDown) return;
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)
      return;
    e.stopPropagation();
    e.preventDefault();
    dispatchingMouseDown = true;
    (e.target as HTMLElement).dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: e.detail,
        screenX: e.screenX,
        screenY: e.screenY,
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        buttons: e.buttons,
        relatedTarget: e.relatedTarget,
        shiftKey: true,
        altKey: true,
      })
    );
    dispatchingMouseDown = false;
  };

  // Intercept right-click (button 2) before xterm forwards it to tmux
  // as an SGR mouse event, which triggers tmux's display-menu. Stopping
  // propagation here keeps the browser's native contextmenu event intact
  // so the user gets the standard copy/paste menu without a tmux menu
  // overlapping it. Focus xterm's textarea so native Paste targets it.
  const onRightMouseDown = (e: MouseEvent) => {
    if (e.button !== 2) return;
    e.stopPropagation();
    const textarea = host.querySelector(
      "textarea.xterm-helper-textarea"
    ) as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  };
  host.addEventListener("mousedown", onRightMouseDown, true);

  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: true });
  const onWheel = () => noteScrollInteractionRef.current();
  if (screenEl) {
    screenEl.addEventListener("mousedown", onMouseDown, true);
    screenEl.addEventListener("wheel", onWheel, { passive: true });
  }

  return () => {
    host.removeEventListener("mousedown", onRightMouseDown, true);
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    if (screenEl) {
      screenEl.removeEventListener("mousedown", onMouseDown, true);
      screenEl.removeEventListener("wheel", onWheel);
    }
  };
}
