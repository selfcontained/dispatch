import { useSyncExternalStore } from "react";

/**
 * Safe-area insets for anchored overlays.
 *
 * Floating UI (under Radix popovers, menus and selects) already clips to the
 * visual viewport, so an open virtual keyboard or pinch zoom is handled. What
 * it cannot see is the device chrome drawn on top of the page: in the
 * installed iOS/iPadOS app the status bar is translucent and sits over the
 * top of the layout, so a popover placed at the top edge ends up underneath
 * it. `env(safe-area-inset-*)` only exists in CSS, so it is measured here and
 * folded into each overlay's collision padding.
 */

export type Side = "top" | "right" | "bottom" | "left";
export type Insets = Record<Side, number>;
export type CollisionPadding = number | Partial<Insets>;

const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];
const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Gap past the safe area when a caller passes no collisionPadding. Matches
 * Radix's own default (0), so where there are no insets (desktop browsers)
 * placement is unchanged.
 */
export const OVERLAY_EDGE_GAP = 0;

/**
 * A tiny external store fed by window events. Every subscriber shares one
 * snapshot and one set of listeners, so an update seen by one is delivered
 * to all of them.
 *
 * `read` can be expensive (the safe-area probe forces a style recalc), so it
 * runs only when the value can have changed: the first read, a window event,
 * or the first subscriber while no listeners are attached (events may have
 * been missed since the last read). Further subscribers reuse the shared
 * snapshot.
 */
function createWindowStore<T>(
  read: () => T,
  same: (a: T, b: T) => boolean,
  attach: (update: () => void) => () => void
) {
  let snapshot: T | undefined;
  // False once listeners detach: window events are no longer tracked, so the
  // snapshot may be stale by the time someone subscribes again.
  let current = false;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;
  const update = () => {
    const next = read();
    current = true;
    if (snapshot !== undefined && same(next, snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!detach) {
        detach = attach(update);
        if (!current) update();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
          current = false;
        }
      };
    },
    getSnapshot(): T {
      // Not marked current: nothing tracks window events until the first
      // subscriber attaches, so that subscriber re-reads once.
      if (snapshot === undefined) snapshot = read();
      return snapshot;
    },
  };
}

function measureSafeArea(): Insets {
  if (typeof document === "undefined" || !document.body) return ZERO;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    SIDES.map(
      (side) => `padding-${side}:env(safe-area-inset-${side},0px)`
    ).join(";");
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const next = Object.fromEntries(
    SIDES.map((side) => [
      side,
      Number.parseFloat(style.getPropertyValue(`padding-${side}`)) || 0,
    ])
  ) as Insets;
  probe.remove();
  return next;
}

const safeAreaStore = createWindowStore<Insets>(
  measureSafeArea,
  (a, b) => SIDES.every((side) => a[side] === b[side]),
  (update) => {
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }
);

/** Current `env(safe-area-inset-*)` values in CSS pixels. */
export function useSafeAreaInsets(): Insets {
  return useSyncExternalStore(
    safeAreaStore.subscribe,
    safeAreaStore.getSnapshot,
    () => ZERO
  );
}

/**
 * Collision padding that keeps an overlay clear of the device safe areas.
 * A caller's own padding is kept as the gap beyond the safe area.
 */
export function safeCollisionPadding(
  insets: Insets,
  padding: CollisionPadding = OVERLAY_EDGE_GAP
): Insets {
  return Object.fromEntries(
    SIDES.map((side) => [
      side,
      insets[side] +
        (typeof padding === "number"
          ? padding
          : (padding[side] ?? OVERLAY_EDGE_GAP)),
    ])
  ) as Insets;
}

export function useSafeCollisionPadding(padding?: CollisionPadding): Insets {
  return safeCollisionPadding(useSafeAreaInsets(), padding);
}
