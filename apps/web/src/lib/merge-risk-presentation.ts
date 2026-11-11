import type { MergeRiskSummary } from "@dispatch/shared";

export const MERGE_RISK = {
  routine: {
    label: "Routine",
    badge: "border-status-working/20 bg-status-working/10 text-status-working",
    hint: "Existing features or infrastructure.",
  },
  human_review: {
    label: "Read before merge",
    badge: "border-red-500/20 bg-red-500/10 text-red-600",
    hint: "Review recommended for this change.",
  },
  abstain: {
    label: "No recommendation",
    badge: "border-border bg-muted/50 text-muted-foreground",
    hint: "Not enough evidence for a recommendation.",
  },
} satisfies Record<
  MergeRiskSummary["verdict"],
  { label: string; badge: string; hint: string }
>;
