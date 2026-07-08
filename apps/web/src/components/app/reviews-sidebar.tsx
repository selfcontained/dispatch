import { memo, useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  MessageCircle,
  User,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";

import {
  useAgentReviews,
  useAgentReviewDetail,
  type ReviewListItem,
  type ReviewFeedbackItem,
} from "@/hooks/use-agent-reviews";
import { agentDiffQueryKey, type DiffResponse } from "@/hooks/use-agent-diff";
import { cn } from "@/lib/utils";

type ReviewsSidebarContentProps = {
  agentId: string | null;
  onNavigateToFile?: (filePath: string, lineStart: number | null) => void;
};

export const ReviewsSidebarContent = memo(function ReviewsSidebarContent({
  agentId,
  onNavigateToFile,
}: ReviewsSidebarContentProps): JSX.Element {
  const { reviews, isLoading } = useAgentReviews(agentId, !!agentId);
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const diffFilePaths = useMemo(() => {
    if (!agentId) return undefined;
    const queries = queryClient.getQueriesData<DiffResponse>({
      queryKey: agentDiffQueryKey(agentId),
    });
    const files = queries[0]?.[1]?.files;
    if (!files) return undefined;
    return new Set(files.map((f) => f.path));
  }, [agentId, queryClient]);

  if (selectedReviewId !== null && agentId) {
    return (
      <ReviewDetail
        agentId={agentId}
        reviewId={selectedReviewId}
        onBack={() => setSelectedReviewId(null)}
        onNavigateToFile={onNavigateToFile}
        diffFilePaths={diffFilePaths}
      />
    );
  }

  if (!agentId) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        Focus an agent to view reviews.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        Loading reviews…
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageCircle className="h-8 w-8 text-muted-foreground" />
          <p>No reviews yet</p>
          <p className="text-xs">
            Open the Changes tab and use "Start review" to submit feedback.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {reviews.map((review) => (
        <ReviewListRow
          key={review.id}
          review={review}
          onClick={() => setSelectedReviewId(review.id)}
        />
      ))}
    </div>
  );
});

function ReviewListRow({
  review,
  onClick,
}: {
  review: ReviewListItem;
  onClick: () => void;
}): JSX.Element {
  const date = new Date(review.createdAt);
  const timeStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-border/30 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      onClick={onClick}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <User className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">
            {review.reviewerType === "human" ? "Human" : "Agent"} review
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0 text-[10px] font-medium",
              review.status === "resolved"
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            )}
          >
            {review.status}
          </span>
        </div>
        {review.summary && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {review.summary}
          </p>
        )}
        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {timeStr}
          </span>
          <span className="flex items-center gap-1">
            <MessageCircle className="h-2.5 w-2.5" />
            {review.resolvedCount}/{review.itemCount} resolved
          </span>
        </div>
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function ReviewDetail({
  agentId,
  reviewId,
  onBack,
  onNavigateToFile,
  diffFilePaths,
}: {
  agentId: string;
  reviewId: number;
  onBack: () => void;
  onNavigateToFile?: (filePath: string, lineStart: number | null) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const { review, isLoading } = useAgentReviewDetail(agentId, reviewId, true);

  if (isLoading || !review) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        Loading review…
      </div>
    );
  }

  const date = new Date(review.createdAt);
  const timeStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back
        </button>
        <div className="flex-1" />
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            review.status === "resolved"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          )}
        >
          {review.status}
        </span>
      </div>

      {review.summary && (
        <div className="border-b border-border/30 px-4 py-3">
          <p className="text-xs text-foreground">{review.summary}</p>
        </div>
      )}

      {review.status === "open" && (
        <div className="border-b border-border/30 px-4 py-2">
          <p className="text-[10px] text-muted-foreground">
            Sent to agent — waiting for response · {timeStr}
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {review.items.map((item) => (
          <FeedbackItemRow
            key={item.id}
            item={item}
            onNavigateToFile={onNavigateToFile}
            diffFilePaths={diffFilePaths}
          />
        ))}
      </div>
    </div>
  );
}

function formatFilePath(
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null
): string {
  let label = filePath;
  if (lineStart) {
    label += `:${lineStart}`;
    if (lineEnd && lineEnd !== lineStart) label += `-${lineEnd}`;
  }
  return label;
}

function FeedbackItemRow({
  item,
  onNavigateToFile,
  diffFilePaths,
}: {
  item: ReviewFeedbackItem;
  onNavigateToFile?: (filePath: string, lineStart: number | null) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(item.status !== "resolved");
  const firstMessage = item.messages[0]?.content?.body ?? "";
  const isResolved = item.status === "resolved";

  const statusLabel = isResolved ? "Resolved" : "Pending";

  const fileInDiff =
    !diffFilePaths || !item.filePath || diffFilePaths.has(item.filePath);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.filePath && onNavigateToFile && fileInDiff) {
        onNavigateToFile(item.filePath, item.lineStart);
      }
    },
    [item, onNavigateToFile, fileInDiff]
  );

  const fullPathLabel = item.filePath
    ? formatFilePath(item.filePath, item.lineStart, item.lineEnd)
    : null;

  return (
    <div
      className={cn(
        "mb-2 overflow-hidden rounded-md border transition-colors",
        isResolved ? "border-border/30 opacity-60" : "border-border/50"
      )}
    >
      <div
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left",
          isResolved ? "bg-muted/10" : "bg-muted/20"
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
        <MessageCircle
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isResolved ? "text-emerald-500" : "text-amber-500"
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0 text-[10px] font-medium",
                isResolved
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              )}
            >
              {statusLabel}
            </span>
            {item.filePath && (
              <button
                type="button"
                className={cn(
                  "min-w-0 font-mono text-[10px]",
                  fileInDiff
                    ? "text-primary hover:underline"
                    : "text-muted-foreground cursor-default"
                )}
                onClick={handleFileClick}
                title={
                  fileInDiff
                    ? (fullPathLabel ?? undefined)
                    : `${fullPathLabel} (not in current diff)`
                }
                style={{ direction: "rtl", textAlign: "left" }}
              >
                <bdi className="block truncate">{fullPathLabel}</bdi>
              </button>
            )}
          </div>
          {!expanded && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {firstMessage}
            </p>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/30 px-3 pb-3">
              {item.diffSnapshot && (
                <pre className="mt-2 max-h-32 overflow-auto rounded border border-border/30 bg-muted/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/70">
                  {item.diffSnapshot}
                </pre>
              )}
              {item.messages.map((msg) => (
                <div key={msg.id} className="mt-2 first:mt-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="font-medium">
                      {msg.authorType === "human" ? "Human" : "Agent"}
                    </span>
                    <span>·</span>
                    <span>
                      {new Date(msg.createdAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/80">
                    {msg.content?.body}
                  </p>
                </div>
              ))}
              {item.resolution && (
                <div className="mt-2 rounded border border-border/30 bg-muted/20 px-3 py-2">
                  <div className="text-[10px] font-medium text-muted-foreground">
                    Resolution: {item.resolution}
                  </div>
                  {item.resolutionNote && (
                    <p className="mt-0.5 text-xs text-foreground/70">
                      {item.resolutionNote}
                    </p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
