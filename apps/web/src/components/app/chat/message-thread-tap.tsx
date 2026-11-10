import { MOBILE_BREAKPOINT_QUERY } from "@/hooks/use-layout";
import { useEffect, useRef, type ReactNode } from "react";

const INTERACTIVE =
  'a,button,input,textarea,select,label,summary,[role="button"],[role="link"],[role="menuitem"],[contenteditable="true"],[tabindex],pre,code,[data-no-thread-tap]';
const TAP_SLOP = 8;
const HOLD_MS = 500;
// Check at the gesture boundaries so resizing cannot complete a phone tap
// on a larger screen. CSS uses the same md breakpoint for the touch padding.
const phoneViewport = () =>
  window.matchMedia?.(MOBILE_BREAKPOINT_QUERY).matches ?? false;

/** Passive gesture classification; the existing reply button owns keyboard access. */
export function MessageThreadTap({
  onOpen,
  children,
}: {
  onOpen?: () => void;
  children: ReactNode;
}) {
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    valid: boolean;
    released: boolean;
  } | null>(null);
  useEffect(() => {
    const cancel = () => {
      if (gesture.current) gesture.current.valid = false;
    };
    const pointer = (event: PointerEvent) => {
      if (!event.isPrimary) cancel();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("scroll", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("scroll", cancel, true);
    };
  }, []);
  const selection = () => !!window.getSelection()?.toString();
  const interactive = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(INTERACTIVE);
  return (
    <div
      className={
        onOpen
          ? "max-md:-mx-2 max-md:min-h-11 max-md:px-2 max-md:py-2"
          : undefined
      }
      data-message-thread-tap={onOpen ? "true" : undefined}
      onPointerDown={(event) => {
        if (!onOpen || !phoneViewport()) {
          gesture.current = null;
          return;
        }
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
        const tap = gesture.current;
        if (!tap || tap.id !== event.pointerId) return;
        tap.released = true;
        tap.valid &&=
          performance.now() - tap.at < HOLD_MS &&
          Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= TAP_SLOP;
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onPointerLeave={() => {
        if (gesture.current && !gesture.current.released)
          gesture.current.valid = false;
      }}
      onDragStart={() => {
        gesture.current = null;
      }}
      onContextMenu={() => {
        gesture.current = null;
      }}
      onClick={(event) => {
        const tap = gesture.current;
        gesture.current = null;
        if (
          phoneViewport() &&
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
