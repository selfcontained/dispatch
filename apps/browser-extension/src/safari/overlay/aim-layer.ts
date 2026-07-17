/**
 * Aiming-phase input handling. While active, page clicks are swallowed so a
 * tap selects instead of activating links and buttons — but touch scrolling
 * is left alone so the user can still reach the element. Events that pass
 * through the overlay host (the toolbar's own buttons) are exempt.
 */

const TAP_MAX_MOVEMENT_PX = 12;
const TAP_MAX_DURATION_MS = 700;

export interface AimCallbacks {
  /** A tap (or non-touch click) committed this element as the target. */
  onTargetCommitted(target: Element): void;
  /** A non-touch pointer is hovering this element (trackpad/mouse preview). */
  onHover(target: Element): void;
  onCancel(): void;
}

function pathElement(event: Event, host: Element): Element | null {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof Element)) continue;
    if (entry === host || host.contains(entry)) return null;
    return entry;
  }
  return null;
}

function eventIsInHost(event: Event, host: Element): boolean {
  return event
    .composedPath()
    .some((entry) => entry instanceof Element && entry === host);
}

export function startAiming(
  host: Element,
  callbacks: AimCallbacks
): () => void {
  let pointerStart: { x: number; y: number; time: number } | null = null;

  function block(event: Event): void {
    if (eventIsInHost(event, host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function blockPropagationOnly(event: Event): void {
    if (eventIsInHost(event, host)) return;
    event.stopImmediatePropagation();
  }

  function handlePointerDown(event: PointerEvent): void {
    if (eventIsInHost(event, host)) return;
    event.stopImmediatePropagation();
    pointerStart = { x: event.clientX, y: event.clientY, time: Date.now() };
  }

  function handlePointerUp(event: PointerEvent): void {
    if (eventIsInHost(event, host)) return;
    event.stopImmediatePropagation();
    const start = pointerStart;
    pointerStart = null;
    if (!start) return;
    const movement = Math.hypot(
      event.clientX - start.x,
      event.clientY - start.y
    );
    const duration = Date.now() - start.time;
    // Anything longer or farther was a scroll or drag, not a tap.
    if (movement > TAP_MAX_MOVEMENT_PX || duration > TAP_MAX_DURATION_MS) {
      return;
    }
    const target =
      pathElement(event, host) ??
      document.elementFromPoint(event.clientX, event.clientY);
    if (target && !(target === host || host.contains(target))) {
      callbacks.onTargetCommitted(target);
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const target = pathElement(event, host);
    if (target) callbacks.onHover(target);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    callbacks.onCancel();
  }

  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointercancel", blockPropagationOnly, true);
  window.addEventListener("mousedown", block, true);
  window.addEventListener("mouseup", block, true);
  window.addEventListener("click", block, true);
  window.addEventListener("touchend", block, {
    capture: true,
    passive: false,
  });
  window.addEventListener("keydown", handleKeydown, true);

  return () => {
    window.removeEventListener("pointerdown", handlePointerDown, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointercancel", blockPropagationOnly, true);
    window.removeEventListener("mousedown", block, true);
    window.removeEventListener("mouseup", block, true);
    window.removeEventListener("click", block, true);
    window.removeEventListener("touchend", block, true);
    window.removeEventListener("keydown", handleKeydown, true);
  };
}
