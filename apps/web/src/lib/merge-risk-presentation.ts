import type { MergeRiskSummary } from "@dispatch/shared";

export const MERGE_RISK = {
  routine: {
    label: "Routine",
    badge: "border-success/line bg-success/tint text-success",
    hint: "Existing features or infrastructure.",
  },
  human_review: {
    label: "Read before merge",
    badge: "border-danger/line bg-danger/tint text-danger",
    hint: "Review recommended for this change.",
  },
  abstain: {
    label: "No recommendation",
    badge: "border-border bg-surface-hover text-muted-foreground",
    hint: "Not enough evidence for a recommendation.",
  },
} satisfies Record<
  MergeRiskSummary["verdict"],
  { label: string; badge: string; hint: string }
>;
