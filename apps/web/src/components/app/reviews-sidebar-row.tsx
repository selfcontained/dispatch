import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import {
  useAgentReviewDetail,
  type ReviewListItem,
} from "@/hooks/use-agent-reviews";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import { FeedbackItemRow } from "@/components/app/reviews-feedback-item";
import {
  reviewerLabel,
  reviewStatusStyle,
  ReviewSummaryBlock,
} from "@/components/app/review-summary-block";

export function ReviewRow({
  agentId,
  review,
  expanded,
  onToggle,
  onNavigateToFile,
  diffFilePaths,
}: {
  agentId: string;
  review: ReviewListItem;
  expanded: boolean;
  onToggle: () => void;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const { review: detail } = useAgentReviewDetail(agentId, review.id, expanded);
  const rowRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      setPinned(false);
      return;
    }

    const header = headerRef.current;
    if (!header) return;

    let scrollParent = header.parentElement;
    while (scrollParent) {
      const overflowY = window.getComputedStyle(scrollParent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) return;

    const updatePinnedState = () => {
      const headerTop = header.getBoundingClientRect().top;
      const scrollTop = scrollParent.getBoundingClientRect().top;
      const nextPinned = headerTop <= scrollTop + 1;
      setPinned((current) => (current === nextPinned ? current : nextPinned));
    };

    const frame = window.requestAnimationFrame(updatePinnedState);
    scrollParent.addEventListener("scroll", updatePinnedState, {
      passive: true,
    });
    window.addEventListener("resize", updatePinnedState);

    return () => {
      window.cancelAnimationFrame(frame);
      scrollParent.removeEventListener("scroll", updatePinnedState);
      window.removeEventListener("resize", updatePinnedState);
    };
  }, [expanded]);

  const statusStyle = reviewStatusStyle(review.status);
  const timeStr = new Date(review.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      ref={rowRef}
      data-review-id={review.id}
      className="relative mb-3 rounded-md bg-muted/[0.07]"
    >
      <ReviewSummaryBlock
        review={review}
        expanded={expanded}
        onClick={onToggle}
        headerRef={headerRef}
        ariaLabel={`${expanded ? "Collapse" : "Expand"} review from ${reviewerLabel(
          review.reviewerType,
          review.reviewerName
        )}`}
        className={cn(
          "sticky -top-2.5 z-20",
          expanded && "rounded-b-none shadow-[0_1px_2px_0_rgb(0_0_0_/_0.08)]",
          pinned && "rounded-none"
        )}
        buttonClassName={cn(
          expanded && "rounded-b-none",
          pinned && "rounded-none"
        )}
      />
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="review-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-clip"
          >
            <div
              className={cn("border-l-2 px-1.5 pb-2 pt-1", statusStyle.rail)}
            >
              {review.summary && (
                <div
                  data-testid={`review-description-${review.id}`}
                  className="mx-1 mb-2 select-text rounded-md bg-muted/20 px-3 py-2.5 text-xs leading-[1.45] text-foreground/90"
                >
                  <Markdown
                    className={cn(
                      "text-xs leading-[1.45] text-foreground/90",
                      "prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0",
                      "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                    )}
                  >
                    {review.summary}
                  </Markdown>
                </div>
              )}
              {review.status === "open" && (
                <p className="mb-2 px-1 text-[10px] text-muted-foreground">
                  {review.reviewerType === "agent"
                    ? "Reviewer feedback submitted — awaiting action"
                    : "Sent for review — waiting for response"}{" "}
                  · {timeStr}
                </p>
              )}
              {detail ? (
                detail.items.length === 0 ? (
                  <div className="mx-1 rounded-md border border-status-working/25 bg-status-working/[0.06] px-3 py-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-status-working">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approved without feedback
                    </p>
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                      The reviewer found no actionable issues. The review
                      summary above records their rationale.
                    </p>
                  </div>
                ) : (
                  detail.items.map((item) => (
                    <FeedbackItemRow
                      key={item.id}
                      agentId={agentId}
                      item={item}
                      onNavigateToFile={onNavigateToFile}
                      diffFilePaths={diffFilePaths}
                    />
                  ))
                )
              ) : (
                <div className="flex items-center justify-center py-4 text-[10px] text-muted-foreground">
                  Loading items…
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
