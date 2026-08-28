import type { Tone } from "./types";

/** Semantic classes shared by all tone-aware surface blocks. */
export type ToneClasses = {
  dot: string;
  text: string;
  bar: string;
  badge: string;
};

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  neutral: {
    dot: "bg-foreground/50",
    text: "text-foreground",
    bar: "bg-foreground/60",
    badge: "border-border bg-muted text-muted-foreground",
  },
  info: {
    dot: "bg-status-done",
    text: "text-status-done",
    bar: "bg-status-done",
    badge: "border-status-done/40 bg-status-done/10 text-status-done",
  },
  success: {
    dot: "bg-status-working",
    text: "text-status-working",
    bar: "bg-status-working",
    badge: "border-status-working/40 bg-status-working/10 text-status-working",
  },
  warning: {
    dot: "bg-status-waiting",
    text: "text-status-waiting",
    bar: "bg-status-waiting",
    badge: "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
  },
  danger: {
    dot: "bg-status-blocked",
    text: "text-status-blocked",
    bar: "bg-status-blocked",
    badge: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
  },
};
