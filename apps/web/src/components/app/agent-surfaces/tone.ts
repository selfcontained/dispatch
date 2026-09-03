import type { Tone } from "./types";

/** Semantic classes shared by all tone-aware surface blocks. */
export type ToneClasses = {
  dot: string;
  text: string;
  bar: string;
  /**
   * Badge weights are deliberately uneven: color budget belongs to the
   * exception. `danger`/`warning` keep the filled pill, `info` is outlined,
   * `success` is a dim label with no pill chrome, and `neutral` is plain
   * muted text — so a category or a healthy state never competes with the
   * one failing value the user is scanning for.
   */
  badge: string;
  /** Left-rule callout treatment used by toned text blocks. */
  callout: string;
};

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  neutral: {
    dot: "bg-foreground/50",
    text: "text-foreground",
    bar: "bg-foreground/40",
    badge: "border-transparent bg-transparent px-0 text-muted-foreground",
    callout: "border-l-foreground/30 bg-muted/40",
  },
  info: {
    dot: "bg-status-done",
    text: "text-status-done",
    bar: "bg-status-done",
    badge: "border-status-done/30 bg-transparent text-status-done/80",
    callout: "border-l-status-done bg-status-done/[0.06]",
  },
  success: {
    dot: "bg-status-working",
    text: "text-status-working",
    bar: "bg-status-working",
    badge: "border-transparent bg-transparent px-0 text-status-working/70",
    callout: "border-l-status-working bg-status-working/[0.06]",
  },
  warning: {
    dot: "bg-status-waiting",
    text: "text-status-waiting",
    bar: "bg-status-waiting",
    badge: "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
    callout: "border-l-status-waiting bg-status-waiting/[0.06]",
  },
  danger: {
    dot: "bg-status-blocked",
    text: "text-status-blocked",
    bar: "bg-status-blocked",
    badge: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
    callout: "border-l-status-blocked bg-status-blocked/[0.06]",
  },
};
