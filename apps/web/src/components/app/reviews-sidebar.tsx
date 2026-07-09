import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  MessageCircle,
  User,
  XCircle,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const REVIEW_STATUS_STYLES: Record<
  string,
  { border: string; badge: string; label: string }
> = {
  open: {
    border: "border-l-amber-400/60",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    label: "Open",
  },
  partially_resolved: {
    border: "border-l-amber-400/60",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    label: "Open",
  },
  resolved: {
    border: "border-l-emerald-400/60",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    label: "Resolved",
  },
};

const DEFAULT_REVIEW_STYLE = REVIEW_STATUS_STYLES.open!;

type FeedbackState = "open" | "fixed" | "dismissed";

function feedbackState(item: ReviewFeedbackItem): FeedbackState {
  if (item.status !== "resolved") return "open";
  if (item.resolution === "fixed") return "fixed";
  return "dismissed";
}

type ReviewsSidebarContentProps = {
  agentId: string | null;
  onNavigateToFile?: (filePath: string, lineStart: number | null) => void;
  autoExpandReviewId?: number | null;
  onAutoExpandConsumed?: () => void;
};

export const ReviewsSidebarContent = memo(function ReviewsSidebarContent({
  agentId,
  onNavigateToFile,
  autoExpandReviewId,
  onAutoExpandConsumed,
}: ReviewsSidebarContentProps): JSX.Element {
  const { reviews, isLoading } = useAgentReviews(agentId, !!agentId);
  const [expandedReviewId, setExpandedReviewId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (autoExpandReviewId != null) {
      setExpandedReviewId(autoExpandReviewId);
      onAutoExpandConsumed?.();
    }
  }, [autoExpandReviewId, onAutoExpandConsumed]);

  const diffFilePaths = useMemo(() => {
    if (!agentId) return undefined;
    const queries = queryClient.getQueriesData<DiffResponse>({
      queryKey: agentDiffQueryKey(agentId),
    });
    const files = queries[0]?.[1]?.files;
    if (!files) return undefined;
    return new Set(files.map((f) => f.path));
  }, [agentId, queryClient]);

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
            Open the Changes tab and use &quot;Start review&quot; to submit
            feedback.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {reviews.map((review) => (
          <ReviewRow
            key={review.id}
            agentId={agentId}
            review={review}
            expanded={expandedReviewId === review.id}
            onToggle={() =>
              setExpandedReviewId((prev) =>
                prev === review.id ? null : review.id
              )
            }
            onNavigateToFile={onNavigateToFile}
            diffFilePaths={diffFilePaths}
          />
        ))}
      </div>
    </TooltipProvider>
  );
});

function ReviewRow({
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
  onNavigateToFile?: (filePath: string, lineStart: number | null) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const { review: detail } = useAgentReviewDetail(agentId, review.id, expanded);

  const statusStyle =
    REVIEW_STATUS_STYLES[review.status] ?? DEFAULT_REVIEW_STYLE;

  const date = new Date(review.createdAt);
  const timeStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={cn(
        "relative mb-3 rounded-md border border-border/40 border-l-2 bg-muted/5",
        statusStyle.border
      )}
    >
      <span
        className={cn(
          "absolute -top-1.5 right-2 z-10 rounded-full px-1.5 py-0 text-[10px] font-medium",
          statusStyle.badge
        )}
      >
        {statusStyle.label}
      </span>
      <button
        type="button"
        className="flex w-full items-start gap-2 overflow-hidden px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <ChevronRight
          className={cn(
            "mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
        {review.reviewerType === "human" ? (
          <User className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          {review.summary && (
            <p
              className={cn(
                "text-xs text-foreground/90",
                !expanded && "truncate"
              )}
            >
              {review.summary}
            </p>
          )}
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <MessageCircle className="h-2.5 w-2.5" />
              {review.resolvedCount}/{review.itemCount} resolved
            </span>
            {expanded && (
              <span className="flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {timeStr}
              </span>
            )}
          </div>
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="review-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/30 px-2 py-2">
              {review.status === "open" && (
                <p className="mb-2 px-1 text-[10px] text-muted-foreground">
                  Sent to agent — waiting for response · {timeStr}
                </p>
              )}
              {detail ? (
                detail.items.map((item) => (
                  <FeedbackItemRow
                    key={item.id}
                    item={item}
                    onNavigateToFile={onNavigateToFile}
                    diffFilePaths={diffFilePaths}
                  />
                ))
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
  const state = feedbackState(item);
  const [expanded, setExpanded] = useState(state === "open");
  const firstMessage = item.messages[0]?.content?.body ?? "";
  const remainingMessages = item.messages.slice(1);

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

  const stateIcon =
    state === "fixed" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    ) : state === "dismissed" ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <MessageCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    );

  return (
    <div
      className={cn(
        "mb-2 ml-2 overflow-hidden rounded-md border transition-colors",
        state === "open" ? "border-border/50" : "border-border/30"
      )}
    >
      <div
        className={cn(
          "cursor-pointer px-3 py-2 text-left",
          state === "open" ? "bg-muted/20" : "bg-muted/10"
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          {stateIcon}
          {item.filePath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "block min-w-0 truncate font-mono text-[10px]",
                    fileInDiff
                      ? "text-primary hover:underline"
                      : "text-muted-foreground cursor-default line-through decoration-muted-foreground/40"
                  )}
                  onClick={handleFileClick}
                  dir="rtl"
                >
                  {fullPathLabel}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p className="font-mono text-xs break-all">
                  {fullPathLabel}
                  {!fileInDiff && (
                    <span className="ml-1 text-muted-foreground">
                      (not in current diff)
                    </span>
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-1.5 mr-6 pl-5">
          <div className="rounded-lg rounded-tl-sm bg-blue-500/10 px-2.5 py-1.5">
            <p
              className={cn(
                "whitespace-pre-wrap text-xs text-foreground/90",
                !expanded && "line-clamp-1"
              )}
            >
              {firstMessage}
            </p>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded &&
          (remainingMessages.length > 0 ||
            item.diffSnapshot ||
            item.resolution) && (
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
                {remainingMessages.map((msg) => {
                  const isAgent = msg.authorType !== "human";
                  return (
                    <div
                      key={msg.id}
                      className={cn("mt-2.5", isAgent ? "pl-6" : "pr-6")}
                    >
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-[10px] text-muted-foreground",
                          isAgent && "justify-end"
                        )}
                      >
                        <span className="font-medium">
                          {isAgent ? "Agent" : "You"}
                        </span>
                        <span>·</span>
                        <span>
                          {new Date(msg.createdAt).toLocaleTimeString(
                            undefined,
                            { hour: "2-digit", minute: "2-digit" }
                          )}
                        </span>
                      </div>
                      <div
                        className={cn(
                          "mt-0.5 rounded-lg px-2.5 py-1.5",
                          isAgent
                            ? "rounded-tr-sm bg-violet-500/10"
                            : "rounded-tl-sm bg-blue-500/10"
                        )}
                      >
                        <p className="whitespace-pre-wrap text-xs text-foreground/80">
                          {msg.content?.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {item.resolutionNote && (
                  <div className="mt-2.5 rounded bg-muted/30 px-2.5 py-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      Resolution
                    </span>
                    <p className="mt-0.5 text-xs text-foreground/70">
                      {item.resolutionNote}
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
      </AnimatePresence>
    </div>
  );
}
