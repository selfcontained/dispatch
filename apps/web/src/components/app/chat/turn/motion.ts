import type { TargetAndTransition, Variants } from "framer-motion";

/**
 * The harness's motion tokens: the only place a duration or easing is
 * written. Every transition in this directory reads from here, and
 * `MotionConfig reducedMotion="user"` at the pane root collapses all of it
 * for readers who asked for less motion.
 */
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;

export const EASE = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/** Rows that land in the same tick stagger this far apart, up to the cap. */
export const STAGGER_S = 0.02;
export const STAGGER_CAP = 5;

export function rowDelay(indexInBurst: number): number {
  return Math.min(Math.max(indexInBurst, 0), STAGGER_CAP) * STAGGER_S;
}

/** Streamed rows fade without moving the text the user is reading. */
export const rowVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
};

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
};

/** Something leaving: fade and shrink, on the exit easing. */
export const exitShrink: TargetAndTransition = {
  opacity: 0,
  height: 0,
  transition: { duration: DURATION.fast, ease: EASE.exit },
};

export const arrive = (duration: number = DURATION.base) => ({
  duration,
  ease: EASE.standard,
});

/** How many earlier rows started within 50 ms of this one: its slot in the burst. */
export function burstIndex(
  steps: readonly { startedAt: number }[],
  i: number
): number {
  let n = 0;
  for (
    let j = i - 1;
    j >= 0 && steps[i].startedAt - steps[j].startedAt <= 50;
    j -= 1
  )
    n += 1;
  return n;
}
