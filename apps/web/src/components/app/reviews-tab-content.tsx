import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  FileCode2,
  Loader2,
  MessageSquareText,
  User,
  Bot,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import type { Review, ReviewFeedbackItem } from "@/components/app/types";
import {
  useAgentReviews,
  useAgentReviewDetail,
} from "@/hooks/use-agent-reviews";
import { cn } from "@/lib/utils";

type ReviewsTabContentProps = {
  agentId: string | null;
};

export function ReviewsTabContent({
  agentId,
}: ReviewsTabContentProps): JSX.Element {
  const { data: reviews, isLoading } = useAgentReviews(agentId);

  if (!agentId) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        Focus an agent to view reviews.
      </div>
    );
  }

  if (isLoading && !reviews) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading reviews…
      </div>
    );
  }

  if (!reviews || reviews.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageSquareText className="h-8 w-8" />
          <p>No reviews yet</p>
          <p className="text-xs">
            Submit a review from the Changes tab to leave structured feedback.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {reviews.map((review) => (
        <ReviewCard key={review.id} agentId={agentId} review={review} />
      ))}
    </div>
  );
}

function ReviewCard({
  agentId,
  review,
}: {
  agentId: string;
  review: Review;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const itemCount = review.itemCount ?? review.items?.length ?? 0;
  const resolvedCount = review.resolvedCount ?? 0;
  const allResolved = itemCount > 0 && resolvedCount === itemCount;

  return (
    <div className="border-b-2 border-border">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ReviewerBadge reviewerType={review.reviewerType} />
            <span className="text-[10px] text-muted-foreground">
              {formatRelativeDate(review.createdAt)}
            </span>
            <ReviewStatusChip status={review.status} />
          </div>
          {review.summary ? (
            <p className="mt-1 line-clamp-2 text-xs text-foreground/90">
              {review.summary}
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {itemCount} item{itemCount !== 1 ? "s" : ""}
            </span>
            {itemCount > 0 ? (
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      allResolved ? "bg-status-working" : "bg-primary"
                    )}
                    style={{
                      width: `${Math.round((resolvedCount / itemCount) * 100)}%`,
                    }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {resolvedCount}/{itemCount}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="items"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <ReviewItemsList agentId={agentId} reviewId={review.id} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ReviewItemsList({
  agentId,
  reviewId,
}: {
  agentId: string;
  reviewId: string;
}): JSX.Element {
  const { data: review, isLoading } = useAgentReviewDetail(agentId, reviewId);

  if (isLoading && !review) {
    return (
      <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!review?.items?.length) {
    return (
      <div className="px-3 pb-3 text-xs text-muted-foreground">
        No feedback items.
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3 pb-3">
      {review.items.map((item) => (
        <FeedbackItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function FeedbackItemRow({ item }: { item: ReviewFeedbackItem }): JSX.Element {
  const isResolved = item.status === "resolved";
  const firstMessage = item.messages?.[0];

  return (
    <div
      className={cn(
        "rounded-md border border-border/50 px-2.5 py-2",
        isResolved && "opacity-60"
      )}
    >
      <div className="flex items-center gap-1.5">
        <FeedbackStatusChip status={item.status} />
        {item.filePath ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            <FileCode2 className="mr-0.5 inline h-3 w-3" />
            {item.filePath}
            {item.lineStart != null ? (
              <span>
                :{item.lineStart}
                {item.lineEnd != null && item.lineEnd !== item.lineStart
                  ? `-${item.lineEnd}`
                  : ""}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">General</span>
        )}
      </div>
      {firstMessage ? (
        <p className="mt-1 line-clamp-3 text-xs text-foreground/80">
          {firstMessage.content.body}
        </p>
      ) : null}
      {isResolved && item.resolution ? (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-status-working">
          <CheckCircle2 className="h-3 w-3" />
          <span className="capitalize">
            {item.resolution.replace("_", " ")}
          </span>
          {item.resolutionNote ? (
            <span className="text-muted-foreground">
              — {item.resolutionNote}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewerBadge({
  reviewerType,
}: {
  reviewerType: "human" | "agent";
}): JSX.Element {
  if (reviewerType === "human") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
        <User className="h-2.5 w-2.5" />
        Human
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-purple-400">
      <Bot className="h-2.5 w-2.5" />
      Agent
    </span>
  );
}

function ReviewStatusChip({ status }: { status: string }): JSX.Element | null {
  if (status === "resolved") {
    return (
      <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] font-medium text-status-working">
        <CheckCircle2 className="h-3 w-3" />
        Resolved
      </span>
    );
  }
  return null;
}

function FeedbackStatusChip({ status }: { status: string }): JSX.Element {
  if (status === "resolved") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-sm bg-status-working/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-status-working">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Resolved
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-sm bg-primary/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-primary">
        <Clock className="h-2.5 w-2.5" />
        In progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded-sm bg-status-waiting/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-status-waiting">
      <Circle className="h-2.5 w-2.5" />
      Open
    </span>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
