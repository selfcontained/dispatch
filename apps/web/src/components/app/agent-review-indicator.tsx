import { Clipboard, ClipboardCheck, ClipboardList } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentReviewSummary } from "@dispatch/shared";
import { cn } from "@/lib/utils";

export function AgentReviewIndicator({
  agentId,
  pendingLabel,
  review,
  isLoading,
  isError,
}: {
  agentId: string;
  pendingLabel: string;
  review: AgentReviewSummary["agents"][string] | undefined;
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  const status = review?.status ?? "pending";
  const label = review
    ? review.status === "resolved"
      ? "Review submitted — approved (no open findings)"
      : `Review submitted — ${review.status === "partially_resolved" ? "partially resolved" : "changes requested"} (${review.openFindings} open ${review.openFindings === 1 ? "finding" : "findings"})`
    : isLoading
      ? "Loading review status"
      : isError
        ? "Review status unavailable"
        : `No review submitted — ${pendingLabel}`;
  const Icon = review
    ? review.status === "resolved"
      ? ClipboardCheck
      : ClipboardList
    : Clipboard;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={label}
          data-testid={`agent-review-indicator-${agentId}`}
          data-review-status={status}
          className={cn(
            "flex h-11 w-7 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7",
            status === "pending" && "text-muted-foreground",
            status === "open" && "text-status-blocked",
            status === "partially_resolved" && "text-status-waiting",
            status === "resolved" && "text-status-done"
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
