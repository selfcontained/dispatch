import { useEffect, useState } from "react";

import { MOBILE_BREAKPOINT_QUERY } from "@/hooks/use-layout";

const QUERY = "(pointer: coarse)";
/** A touch screen at phone width, where a bottom sheet beats a dropdown. */
const TOUCH_PHONE_QUERY = `${QUERY} and ${MOBILE_BREAKPOINT_QUERY}`;

/**
 * True on touch-first devices. Hover-only affordances (a tooltip on a button)
 * are unreachable there — a tap fires the click instead of opening the
 * tooltip — so callers need a different way to disclose what an action does.
 */
function match(query: string): MediaQueryList | null {
  // Guarded: jsdom and older embedded webviews have no matchMedia, and a
  // missing pointer signal should degrade to "fine pointer", not throw.
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(query);
}

function useMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => match(query)?.matches ?? false);

  useEffect(() => {
    const media = match(query);
    if (!media) return;
    const onChange = (event: MediaQueryListEvent): void =>
      setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function useCoarsePointer(): boolean {
  return useMatch(QUERY);
}

/** True on a touch screen at phone width (a tablet is not one). */
export function useTouchPhone(): boolean {
  return useMatch(TOUCH_PHONE_QUERY);
}
