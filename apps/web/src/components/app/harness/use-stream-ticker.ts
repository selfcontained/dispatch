// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { useCallback, useSyncExternalStore } from "react";

/**
 * A single, module-level animation ticker shared by every live glyph in the
 * fused assistant stream (braille spinners + "…" dots). One interval drives
 * all of them — never one timer per row, which would multiply across a long
 * trace and drift.
 *
 * The interval only runs while at least one component is actively subscribed
 * (i.e. something is `running`); it stops as soon as the last live glyph
 * unsubscribes, so an idle/finished stream costs nothing.
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

/** Respect the OS reduced-motion setting — when set, the spinner/dots must not
 *  cycle (the JS ticker is invisible to the CSS reduced-motion guard). */
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
