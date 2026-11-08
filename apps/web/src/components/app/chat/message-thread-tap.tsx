import { useEffect, useRef, type ReactNode } from "react";

const INTERACTIVE =
  'a,button,input,textarea,select,label,summary,[role="button"],[role="link"],[role="menuitem"],[contenteditable="true"],[tabindex],pre,code,[data-no-thread-tap]';
const TAP_SLOP = 8;
const HOLD_MS = 500;

/** Text holds belong to native selection; only empty message space reacts. */
function hitsText(root: HTMLElement, x: number, y: number): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    // If geometry is unavailable, prefer preserving native text behavior.
    if (!range.getClientRects) return true;
    for (const rect of Array.from(range.getClientRects())) {
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return true;
    }
  }
  return false;
}

/** Passive gesture classification; the existing reply button owns keyboard access. */
export function MessageThreadTap({
  onOpen,
  children,
  onLongPress,
}: {
  onOpen?: () => void;
  children: ReactNode;
  onLongPress?: (point: { x: number; y: number }) => void;
}) {
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    valid: boolean;
    released: boolean;
  } | null>(null);
  const handled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const clearTimer = () => clearTimeout(timer.current);
  useEffect(() => {
    const cancel = () => {
      clearTimer();
      if (gesture.current) gesture.current.valid = false;
    };
    const pointer = (event: PointerEvent) => {
      if (!event.isPrimary) cancel();
    };
    const selected = () => {
      if (window.getSelection()?.toString()) cancel();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("scroll", cancel, true);
    document.addEventListener("selectionchange", selected);
    return () => {
      clearTimer();
      document.removeEventListener("selectionchange", selected);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("scroll", cancel, true);
    };
  }, []);
  const selection = () => !!window.getSelection()?.toString();
  const interactive = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(INTERACTIVE);
  return (
    <div
      className={onOpen ? "-mx-2 min-h-11 px-2 py-2" : undefined}
      data-message-thread-tap={onOpen ? "true" : undefined}
      onPointerDown={(event) => {
        handled.current = false;
        clearTimer();
        if (!onOpen && !onLongPress) return;
        if (!event.isPrimary || event.button !== 0) {
          if (gesture.current) gesture.current.valid = false;
          return;
        }
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: performance.now(),
          valid: !interactive(event.target) && !selection(),
          released: false,
        };
        const tap = gesture.current;
        if (
          tap.valid &&
          event.pointerType === "touch" &&
          onLongPress &&
          !hitsText(event.currentTarget, tap.x, tap.y)
        ) {
          timer.current = setTimeout(() => {
            if (tap.valid && !tap.released && !selection()) {
              tap.valid = false;
              handled.current = true;
              onLongPress({ x: tap.x, y: tap.y });
            }
          }, HOLD_MS);
        }
      }}
      onTouchStart={(event) => {
        if (event.touches.length > 1 && gesture.current)
          gesture.current.valid = false;
      }}
      onPointerMove={(event) => {
        const tap = gesture.current;
        if (
          tap &&
          tap.id === event.pointerId &&
          Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP
        )
          tap.valid = false;
      }}
      onPointerUp={(event) => {
        clearTimer();
        const tap = gesture.current;
        if (!tap || tap.id !== event.pointerId) return;
        tap.released = true;
        tap.valid &&=
          performance.now() - tap.at < HOLD_MS &&
          Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= TAP_SLOP;
      }}
      onPointerCancel={() => {
        clearTimer();
        gesture.current = null;
      }}
      onPointerLeave={() => {
        if (gesture.current && !gesture.current.released)
          gesture.current.valid = false;
      }}
      onDragStart={() => {
        clearTimer();
        gesture.current = null;
      }}
      onContextMenu={(event) => {
        if (handled.current) event.preventDefault();
        else {
          clearTimer();
          gesture.current = null;
        }
      }}
      onClick={(event) => {
        const tap = gesture.current;
        clearTimer();
        if (handled.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        gesture.current = null;
        if (
          tap?.valid &&
          tap.released &&
          !event.defaultPrevented &&
          !interactive(event.target) &&
          !selection()
        )
          onOpen?.();
      }}
    >
      {children}
    </div>
  );
}
