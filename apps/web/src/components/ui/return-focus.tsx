import * as React from "react";

type Opener = React.MutableRefObject<HTMLElement | null>;

/**
 * Notes what had focus as a dialog renders open, before anything inside it
 * can autofocus.
 */
export function RememberOpener({ opener }: { opener: Opener }): null {
  React.useState(() => {
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    return true;
  });
  return null;
}

/**
 * What opened a layer. A menu item is gone by the time the layer closes, so
 * its menu's trigger stands in for it.
 */
export function opensFrom(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const trigger = active
    .closest('[role="menu"]')
    ?.getAttribute("aria-labelledby");
  return (trigger && document.getElementById(trigger)) || active;
}

/** A phone's sidebar slides away as it opens a dialog, taking the opener along. */
export function slidAway(element: HTMLElement): boolean {
  const { left, right } = element.getBoundingClientRect();
  return right < 0 || left > window.innerWidth;
}

/**
 * Radix returns focus only to its own Trigger. A dialog opened from state
 * returns it to what opened it, unless the caller already placed it.
 */
export function useReturnFocus(): {
  opener: Opener;
  restoreFocus: (event: Event) => void;
} {
  const opener = React.useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => {
    if (event.defaultPrevented || !opener.current?.isConnected) return;
    if (slidAway(opener.current)) return;
    event.preventDefault();
    opener.current.focus({ preventScroll: true });
  };
  return { opener, restoreFocus };
}
