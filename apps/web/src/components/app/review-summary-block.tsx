import { type ReactNode, type RefObject } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  MessageCircle,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * How a review's status reads: the rail down its left edge, the badge, and
 * the word for it. `partially_resolved` says "Open" too — from the reader's
 * side there is still something to do, and the counts say how much.
 */
export const REVIEW_STATUS_STYLES: Record<
  string,
  { rail: string; badge: string; label: string }
> = {
  open: {
    rail: "border-l-status-waiting/60",
    badge: "bg-status-waiting/15 text-status-waiting",
    label: "Open",
  },
  partially_resolved: {
    rail: "border-l-status-waiting/60",
    badge: "bg-status-waiting/15 text-status-waiting",
    label: "Open",
  },
  resolved: {
    rail: "border-l-status-working/60",
    badge: "bg-status-working/15 text-status-working",
    label: "Resolved",
  },
};

const DEFAULT_REVIEW_STYLE = REVIEW_STATUS_STYLES.open!;

export function reviewStatusStyle(
  status: string
): (typeof REVIEW_STATUS_STYLES)[string] {
  return REVIEW_STATUS_STYLES[status] ?? DEFAULT_REVIEW_STYLE;
}

/** Who left a review, as one line: a reviewer's persona, or a person. */
export function reviewerLabel(
  reviewerType: string,
  reviewerName: string | null
): string {
  if (reviewerType !== "agent") return "Human reviewer";
  return reviewerName || "Review agent";
}

/** The fields the block shows — the shape both the sidebar and Chat have. */
export type ReviewSummary = {
  reviewerType: string;
  reviewerName: string | null;
  status: string;
  itemCount: number;
  resolvedCount: number;
  createdAt: string;
};

/**
 * A review at a glance: who left it, how much of it is still open, and its
 * status — the block the Reviews sidebar shows when a review is collapsed,
 * and the same block the Chat feed shows when one lands.
 *
 * The sidebar uses it as the header of an expandable row (`expanded` renders
 * the chevron and squares off the bottom corners); the Chat feed uses it as
 * a plain button that opens the review in the sidebar, with no chevron and
 * no date — the post it sits in is already stamped with the time.
 */
export function ReviewSummaryBlock({
  review,
  expanded,
  showTime = true,
  onClick,
  headerRef,
  className,
  buttonClassName,
  ariaLabel,
  ...rest
}: {
  review: ReviewSummary;
  /** Omit for a block that does not expand: no chevron is rendered. */
  expanded?: boolean;
  /** The sidebar stamps each review; in Chat the post's own time serves. */
  showTime?: boolean;
  onClick?: () => void;
  headerRef?: RefObject<HTMLDivElement>;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  const style = reviewStatusStyle(review.status);
  const label = reviewerLabel(review.reviewerType, review.reviewerName);
  const time = new Date(review.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const meta: ReactNode = (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
      {review.itemCount === 0 ? (
        <span className="flex items-center gap-1 text-status-working">
          <CheckCircle2 className="h-2.5 w-2.5" />
          Approved · no feedback
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <MessageCircle className="h-2.5 w-2.5" />
          {review.resolvedCount}/{review.itemCount} resolved
        </span>
      )}
      {showTime ? (
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {time}
        </span>
      ) : null}
      <span
        className={cn(
          "ml-auto shrink-0 rounded-full px-1.5 py-0.5 font-medium",
          style.badge
        )}
      >
        {style.label}
      </span>
    </div>
  );
  return (
    <div
      ref={headerRef}
      className={cn("rounded-md border-l-2 bg-muted", style.rail, className)}
      {...rest}
    >
      <button
        type="button"
        {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
        aria-label={ariaLabel}
        className={cn(
          "flex w-full items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          buttonClassName
        )}
        onClick={onClick}
      >
        {expanded === undefined ? null : (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
        )}
        {review.reviewerType === "human" ? (
          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground/90">
            Review · {label}
          </p>
          {meta}
        </div>
      </button>
    </div>
  );
}
