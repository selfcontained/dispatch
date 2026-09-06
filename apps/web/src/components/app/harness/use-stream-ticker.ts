// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { useCallback, useSyncExternalStore } from "react";

/**
 * One module-level ticker for every live glyph in the stream (braille
 * spinners and "…" dots). One interval drives them all: a timer per row
 * would multiply across a long trace and drift. It runs only while at
 * least one component is subscribed, so an idle stream costs nothing.
 */
const FRAME_MS = 110;

/** The braille spinner's animation frames, cycled once every 110ms while active. */
export const BRAILLE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

let tick = 0;
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function start(): void {
  if (interval != null) return;
  interval = setInterval(() => {
    tick = (tick + 1) % 10080; // bounded; lcm(10,4)=20 divides it, so frame/dot cycles stay aligned
    for (const l of listeners) l();
  }, FRAME_MS);
}

function stop(): void {
  if (interval != null && listeners.size === 0) {
    clearInterval(interval);
    interval = null;
  }
}

function realSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
    stop();
  };
}

const getSnapshot = () => tick;
const getZero = () => 0;
const noopSubscribe = () => () => {};

/** Under the OS reduced-motion setting the spinner and dots must not cycle:
 *  the CSS reduced-motion guard cannot see a JS ticker. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The current animation frame of the shared stream ticker. */
export type StreamTick = {
  /** Current braille spinner glyph. */
  braille: string;
  /** Animated ellipsis, 0–3 dots. */
  dots: string;
};

/**
 * Subscribe to the shared ticker. Pass `active=false` for finished/idle glyphs
 * so they don't keep the interval alive; they render a stable frame 0.
 */
export function useStreamTicker(active: boolean): StreamTick {
  // Hold a stable frame 0 under reduced-motion (static glyph, no dots).
  const live = active && !prefersReducedMotion();
  const subscribe = useCallback(
    (cb: () => void) => (live ? realSubscribe(cb) : noopSubscribe()),
    [live]
  );
  const frame = useSyncExternalStore(
    subscribe,
    live ? getSnapshot : getZero,
    getZero
  );
  return {
    braille: BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length],
    dots: ".".repeat(frame % 4),
  };
}
