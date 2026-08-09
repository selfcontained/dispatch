import type { MutableRefObject } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type ThemeId, getTerminalPalette } from "@/hooks/use-theme";
import { extensionForMime } from "@/lib/media-upload";

function getTerminalFontFamily(): string {
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-terminal")
    .trim();
  return fontFamily.length > 0
    ? fontFamily
    : '"JetBrains Mono", Menlo, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace';
}

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

export interface TerminalSurfaceRefs {
  terminalRef: MutableRefObject<XTerm | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  fitDebounceRef: MutableRefObject<number | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  ctrlPendingRef: MutableRefObject<boolean>;
  noteScrollInteractionRef: MutableRefObject<() => void>;
  deferMediaResizeRef: MutableRefObject<boolean>;
  uploadFilesRef: MutableRefObject<(files: File[]) => void>;
  terminalInputAtRef: MutableRefObject<number>;
}

export interface TerminalSurfaceCallbacks {
  requestFit: () => void;
  invalidateAttachAttempt: () => void;
  setDraggingFiles: (dragging: boolean) => void;
}

/**
 * Create and mount an XTerm instance with all addons and DOM event handlers.
 * Returns a cleanup function that tears everything down.
 */
export function createTerminalSurface(
  host: HTMLDivElement,
  theme: ThemeId,
  refs: TerminalSurfaceRefs,
  callbacks: TerminalSurfaceCallbacks
): () => void {
  const {
    terminalRef,
    fitAddonRef,
    fitDebounceRef,
    wsRef,
    ctrlPendingRef,
    noteScrollInteractionRef,
    deferMediaResizeRef,
    uploadFilesRef,
    terminalInputAtRef,
  } = refs;
  const { requestFit, invalidateAttachAttempt, setDraggingFiles } = callbacks;

  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
  const palette = getTerminalPalette(theme);
  const term = new XTerm({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: getTerminalFontFamily(),
    fontSize: 13,
    scrollback: 1000,
    macOptionClickForcesSelection: true,
    screenReaderMode: isTouchDevice,
    minimumContrastRatio: palette.minimumContrastRatio ?? 1,
    theme: palette,
  });

  const fit = new FitAddon();
  const unicode11 = new Unicode11Addon();

  terminalRef.current = term;
  fitAddonRef.current = fit;
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";
  term.loadAddon(fit);
  try {
    term.loadAddon(new ClipboardAddon());
  } catch (e) {
    console.warn("ClipboardAddon failed:", e);
  }
  term.open(host);
  fit.fit();

  // -- Clipboard handling --------------------------------------------------

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

  const copyToClipboard = (text: string): void => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {
        copyViaTextarea(text);
      });
    } else {
      copyViaTextarea(text);
    }
  };
  const copyViaTextarea = (text: string): void => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  };
  term.attachCustomKeyEventHandler((event) => {
    if (
      event.type === "keydown" &&
      event.key === "c" &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      term.hasSelection()
    ) {
      copyToClipboard(cleanCopiedText(term.getSelection()));
      event.preventDefault();
      return false;
    }
    return true;
  });

  // -- Image paste (Cmd/Ctrl+V) --------------------------------------------
  // Delegated to use-terminal's unified upload handler. The server decides
  // how to deliver the file (clipboard injection vs typed path).

  const handlePaste = (e: ClipboardEvent) => {
    const imageItem = Array.from(e.clipboardData?.items ?? []).find((item) =>
      item.type.startsWith("image/")
    );
    if (!imageItem) return;
    const blob = imageItem.getAsFile();
    if (!blob) return;
    e.preventDefault();
    e.stopPropagation();
    const named =
      blob.name && blob.name.length > 0
        ? blob
        : new File([blob], `clipboard${extensionForMime(blob.type)}`, {
            type: blob.type,
          });
    uploadFilesRef.current([named]);
  };
  host.addEventListener("paste", handlePaste, true);

  // -- Drag-and-drop file upload --------------------------------------------
  // A nesting counter avoids overlay flicker as the pointer moves over child
  // elements (each fires dragenter/dragleave).
  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    setDraggingFiles(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDraggingFiles(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDraggingFiles(false);
    uploadFilesRef.current(Array.from(e.dataTransfer?.files ?? []));
  };
  host.addEventListener("dragenter", onDragEnter, true);
  host.addEventListener("dragover", onDragOver, true);
  host.addEventListener("dragleave", onDragLeave, true);
  host.addEventListener("drop", onDrop, true);

  // -- Touch / pointer / mouse handling ------------------------------------

  const screenEl = host.querySelector(".xterm-screen") as HTMLElement | null;

  if (isTouchDevice) {
    const a11yEl = host.querySelector(
      ".xterm-accessibility"
    ) as HTMLElement | null;
    if (a11yEl) {
      a11yEl.style.pointerEvents = "auto";
      a11yEl.style.userSelect = "text";
      a11yEl.style.setProperty("-webkit-user-select", "text");
      a11yEl.style.setProperty("-webkit-touch-callout", "default");
      a11yEl.style.touchAction = "auto";
    }
    const selStyle = document.createElement("style");
    selStyle.textContent = [
      ".xterm .xterm-accessibility-tree *::selection {",
      "  background: rgba(65, 132, 228, 0.35) !important;",
      "}",
    ].join("\n");
    host.appendChild(selStyle);
  }

  let touchY = 0;
  let touchAccum = 0;
  const TOUCH_SCROLL_SENSITIVITY_PX = 30;
  const onTouchStart = (e: TouchEvent) => {
    if (!isTouchDevice || e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    touchAccum = 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!isTouchDevice || e.touches.length !== 1) return;
    if (!screenEl) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
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

  let lastPointerType: string = "mouse";
  const onPointerDownTrack = (e: PointerEvent) => {
    lastPointerType = e.pointerType;
  };
  host.addEventListener("pointerdown", onPointerDownTrack, true);

  let dispatchingMouseDown = false;
  const onMouseDown = (e: MouseEvent) => {
    if (dispatchingMouseDown) return;
    if (lastPointerType === "touch") return;
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)
      return;
    e.stopPropagation();
    e.preventDefault();
    dispatchingMouseDown = true;
    const dispatchTarget = screenEl ?? (e.target as HTMLElement);
    dispatchTarget.dispatchEvent(
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
  host.addEventListener("mousedown", onMouseDown, true);
  const onWheel = () => noteScrollInteractionRef.current();
  if (screenEl) {
    screenEl.addEventListener("wheel", onWheel, { passive: true });
  }

  // -- Terminal data → WebSocket -------------------------------------------

  const disposable = term.onData((data) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    terminalInputAtRef.current = Date.now();
    if (ctrlPendingRef.current && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) {
        ctrlPendingRef.current = false;
        window.dispatchEvent(new Event("ctrl-consumed"));
        ws.send(
          JSON.stringify({
            type: "input",
            data: String.fromCharCode(code - 64),
          })
        );
        return;
      }
    }
    ws.send(JSON.stringify({ type: "input", data }));
  });

  // -- Resize handling -----------------------------------------------------

  const onResize = () => {
    if (deferMediaResizeRef.current) return;
    requestFit();
  };

  window.addEventListener("resize", onResize);

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(host);

  // -- Cleanup -------------------------------------------------------------

  return () => {
    invalidateAttachAttempt();
    if (fitDebounceRef.current !== null) {
      window.clearTimeout(fitDebounceRef.current);
      fitDebounceRef.current = null;
    }
    disposable.dispose();
    resizeObserver.disconnect();
    host.removeEventListener("copy", handleCopy, true);
    host.removeEventListener("paste", handlePaste, true);
    host.removeEventListener("dragenter", onDragEnter, true);
    host.removeEventListener("dragover", onDragOver, true);
    host.removeEventListener("dragleave", onDragLeave, true);
    host.removeEventListener("drop", onDrop, true);
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("pointerdown", onPointerDownTrack, true);
    host.removeEventListener("mousedown", onMouseDown, true);
    host.removeEventListener("mousedown", onRightMouseDown, true);
    if (screenEl) {
      screenEl.removeEventListener("wheel", onWheel);
    }
    window.removeEventListener("resize", onResize);
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    term.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
  };
}
