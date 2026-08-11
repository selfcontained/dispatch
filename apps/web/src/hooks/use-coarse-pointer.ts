import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

/**
 * True on touch-first devices. Hover-only affordances (a tooltip on a button)
 * are unreachable there — a tap fires the click instead of opening the
 * tooltip — so callers need a different way to disclose what an action does.
 */
function matchCoarse(): MediaQueryList | null {
  // Guarded: jsdom and older embedded webviews have no matchMedia, and a
  // missing pointer signal should degrade to "fine pointer", not throw.
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(QUERY);
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => matchCoarse()?.matches ?? false);

  useEffect(() => {
    const media = matchCoarse();
    if (!media) return;
    const onChange = (event: MediaQueryListEvent): void =>
      setCoarse(event.matches);
    setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
