import { useSyncExternalStore } from "react";

// A shared environmental clock: sidebar rows need one midnight wakeup, not a
// timer each. Local calendar construction handles daylight-saving transitions.
const listeners = new Set<() => void>();
let midnightTimer: ReturnType<typeof setTimeout> | undefined;

function localDayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function refresh() {
  if (midnightTimer !== undefined) clearTimeout(midnightTimer);
  midnightTimer = undefined;
  for (const listener of listeners) listener();
  if (listeners.size > 0) scheduleMidnight();
}

function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  midnightTimer = setTimeout(refresh, next.getTime() - now.getTime());
}

function subscribe(listener: () => void) {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    scheduleMidnight();
    // Catch up after a suspended tab/device, or a timezone/clock change while
    // away, even if the old midnight timeout has not fired yet.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (midnightTimer !== undefined) clearTimeout(midnightTimer);
      midnightTimer = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

/** Today's local calendar date, refreshed at midnight and when returning. */
export function useLocalDay(): Date {
  return new Date(useSyncExternalStore(subscribe, localDayStart, () => 0));
}
