import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  MessageCircle,
  RotateCcw,
  Send,
  User,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import {
  useAgentReviews,
  useAgentReviewDetail,
  useAddReviewThreadMessage,
  useSetReviewFeedbackResolution,
  type ReviewListItem,
  type ReviewFeedbackItem,
  type ReviewThreadMessage,
} from "@/hooks/use-agent-reviews";
import { useAgentDiff } from "@/hooks/use-agent-diff";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/ui/markdown";
import { ReviewDiffSnapshot } from "@/components/app/review-diff-snapshot";

const REVIEW_STATUS_STYLES: Record<
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

type FeedbackState = "open" | "fixed" | "dismissed";

function feedbackState(item: ReviewFeedbackItem): FeedbackState {
  if (item.status !== "resolved") return "open";
  if (item.resolution === "fixed") return "fixed";
  return "dismissed";
}

type ReviewsSidebarContentProps = {
  agentId: string | null;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
};

export const ReviewsSidebarContent = memo(function ReviewsSidebarContent({
  agentId,
  onNavigateToFile,
}: ReviewsSidebarContentProps): JSX.Element {
  const { reviews, isLoading } = useAgentReviews(agentId, !!agentId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: diffData } = useAgentDiff(agentId, !!agentId);
  const requestedReviewId = Number(searchParams.get("expandReview"));
  const expandedReviewId =
    Number.isInteger(requestedReviewId) && requestedReviewId > 0
      ? requestedReviewId
      : null;
  const setExpandedReviewId = useCallback(
    (reviewId: number | null) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (reviewId == null) next.delete("expandReview");
        else next.set("expandReview", String(reviewId));
        return next;
      });
    },
    [setSearchParams]
  );

  const diffFilePaths = useMemo(() => {
    if (!diffData?.files) return undefined;
    return new Set(diffData.files.map((f) => f.path));
  }, [diffData]);

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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
        {reviews.map((review) => (
          <ReviewRow
            key={review.id}
            agentId={agentId}
            review={review}
            expanded={expandedReviewId === review.id}
            onToggle={() =>
              setExpandedReviewId(
                expandedReviewId === review.id ? null : review.id
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

  const statusStyle =
    REVIEW_STATUS_STYLES[review.status] ?? DEFAULT_REVIEW_STYLE;

  const date = new Date(review.createdAt);
  const timeStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const reviewerLabel =
    review.reviewerType === "agent"
      ? review.reviewerName || "Review agent"
      : "Human reviewer";

  return (
    <div
      ref={rowRef}
      data-review-id={review.id}
      className="relative mb-3 rounded-md bg-muted/[0.07]"
    >
      <div
        ref={headerRef}
        className={cn(
          "sticky -top-2.5 z-20 rounded-md border-l-2 bg-muted",
          expanded && "rounded-b-none shadow-[0_1px_2px_0_rgb(0_0_0_/_0.08)]",
          pinned && "rounded-none",
          statusStyle.rail
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} review from ${reviewerLabel}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            expanded && "rounded-b-none",
            pinned && "rounded-none"
          )}
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          {review.reviewerType === "human" ? (
            <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground/90">
              Review · {reviewerLabel}
            </p>
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
              <span className="flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {timeStr}
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-full px-1.5 py-0.5 font-medium",
                  statusStyle.badge
                )}
              >
                {statusStyle.label}
              </span>
            </div>
          </div>
        </button>
      </div>
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

function formatFilePath(
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null
): string {
  let label = filePath;
  if (lineStart) {
    label += `:${lineStart}`;
    if (lineEnd && lineEnd !== lineStart) label += `–${lineEnd}`;
  }
  return label;
}

function compactFilePath(
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null
): string {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  return formatFilePath(fileName, lineStart, lineEnd);
}

function FeedbackItemRow({
  agentId,
  item,
  onNavigateToFile,
  diffFilePaths,
}: {
  agentId: string;
  item: ReviewFeedbackItem;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const state = feedbackState(item);
  const [expanded, setExpanded] = useState(false);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const addMessage = useAddReviewThreadMessage(agentId);
  const setResolution = useSetReviewFeedbackResolution(agentId);

  const fileInDiff =
    !diffFilePaths || !item.filePath || diffFilePaths.has(item.filePath);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.filePath && onNavigateToFile && fileInDiff) {
        onNavigateToFile(item.filePath, item.lineStart, item.id);
      }
    },
    [item, onNavigateToFile, fileInDiff]
  );

  const fullPathLabel = item.filePath
    ? formatFilePath(item.filePath, item.lineStart, item.lineEnd)
    : null;
  const compactPathLabel = item.filePath
    ? compactFilePath(item.filePath, item.lineStart, item.lineEnd)
    : null;
  const originalFeedback = item.messages[0]?.content?.body ?? "Feedback item";

  const stateIcon =
    state === "fixed" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-working" />
    ) : state === "dismissed" ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Circle className="h-3.5 w-3.5 shrink-0 text-status-waiting" />
    );
  const stateLabel =
    state === "fixed" ? "Fixed" : state === "dismissed" ? "Dismissed" : "Open";

  const submitReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body) return;
    try {
      await addMessage.mutateAsync({ itemId: item.id, body });
      setReply("");
      setReplying(false);
    } catch {
      toast.error("Couldn't send the reply. Try again.");
    }
  };

  const cancelReply = () => {
    setReply("");
    setReplying(false);
  };

  const updateResolution = async (resolution: "fixed" | "dismissed" | null) => {
    try {
      await setResolution.mutateAsync({ itemId: item.id, resolution });
    } catch {
      toast.error("Couldn't update the feedback state. Try again.");
    }
  };

  return (
    <div className="ml-1 pb-2 last:pb-0">
      <div
        className={cn(
          "group relative rounded-md bg-muted/15 text-left",
          !expanded && "transition-colors hover:bg-muted/35",
          expanded && "sticky top-[49px] z-10 rounded-b-none bg-card shadow-sm"
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} feedback`}
          className="flex min-h-11 w-full items-center gap-2 rounded-md border border-primary/50 bg-card px-2.5 py-2.5 text-left transition-colors hover:border-primary/80 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">{stateIcon}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{stateLabel}</TooltipContent>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
            Feedback · {stateLabel}
          </span>
          {compactPathLabel && (
            <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted-foreground">
              {compactPathLabel}
            </span>
          )}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-clip"
          >
            <div className="ml-5 border-l border-border/70 bg-muted/[0.1] px-3 pb-3 pt-2.5">
              {fullPathLabel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {fileInDiff ? (
                      <button
                        type="button"
                        className="mb-2 block w-full truncate text-left font-mono text-[10px] text-primary hover:underline [direction:rtl]"
                        onClick={handleFileClick}
                      >
                        {fullPathLabel}
                      </button>
                    ) : (
                      <p className="mb-2 w-full truncate text-left font-mono text-[10px] text-muted-foreground [direction:rtl]">
                        {fullPathLabel}
                      </p>
                    )}
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
              <div
                data-testid={`feedback-description-${item.id}`}
                className="mb-3 select-text rounded-md bg-muted/20 px-3 py-2.5 text-xs leading-[1.45] text-foreground/90"
              >
                <Markdown
                  className={cn(
                    "text-xs leading-[1.45] text-foreground/90",
                    "prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0",
                    "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  )}
                >
                  {originalFeedback}
                </Markdown>
              </div>
              {item.diffSnapshot && (
                <ReviewDiffSnapshot diff={item.diffSnapshot} className="mt-0" />
              )}
              {item.messages.slice(1).map((message, index, messages) => (
                <ThreadMessage
                  key={message.id}
                  message={message}
                  grouped={
                    index > 0 &&
                    messages[index - 1]?.authorType === message.authorType &&
                    messages[index - 1]?.type === message.type
                  }
                />
              ))}
              <AnimatePresence initial={false}>
                {replying ? (
                  <motion.form
                    key="reply-form"
                    initial={{ height: 0, marginTop: 0, opacity: 0 }}
                    animate={{ height: "auto", marginTop: 12, opacity: 1 }}
                    exit={{ height: 0, marginTop: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeInOut" }}
                    className="-mx-0.5 space-y-2 overflow-hidden p-0.5"
                    onSubmit={submitReply}
                  >
                    <Textarea
                      aria-label="Reply to feedback"
                      className="min-h-0 h-16 resize-none px-2 py-1.5 text-xs"
                      placeholder="Reply to agent…"
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelReply();
                        }
                      }}
                      disabled={addMessage.isPending}
                      autoFocus
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="w-full"
                        onClick={cancelReply}
                        disabled={addMessage.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        className="w-full"
                        aria-label="Send reply"
                        disabled={!reply.trim() || addMessage.isPending}
                      >
                        {addMessage.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1">Send reply</span>
                      </Button>
                    </div>
                  </motion.form>
                ) : (
                  <motion.div
                    key="reply-trigger"
                    initial={{ height: 0, marginTop: 0, opacity: 0 }}
                    animate={{ height: "auto", marginTop: 12, opacity: 1 }}
                    exit={{ height: 0, marginTop: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeInOut" }}
                    className="flex justify-end overflow-hidden"
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => setReplying(true)}
                    >
                      <MessageCircle className="mr-1.5 h-3.5 w-3.5" />
                      Reply
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <footer className="ml-5 border-l border-border/70 bg-muted/[0.06] px-3 pb-3 pt-3">
              {item.resolution && (
                <div
                  className={cn(
                    "mb-3 rounded border px-2.5 py-1.5",
                    item.resolution === "fixed"
                      ? "border-status-working/25 bg-status-working/[0.06]"
                      : "border-muted-foreground/25 bg-muted/30"
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center gap-1 text-[10px] font-medium",
                      item.resolution === "fixed"
                        ? "text-status-working"
                        : "text-muted-foreground"
                    )}
                  >
                    {item.resolution === "fixed" ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    Resolution: {item.resolution}
                  </span>
                  {item.resolutionNote && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/80">
                      {item.resolutionNote}
                    </p>
                  )}
                </div>
              )}
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Feedback state
              </p>
              {state !== "open" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="w-full"
                  disabled={setResolution.isPending}
                  onClick={() => void updateResolution(null)}
                >
                  {setResolution.isPending &&
                  setResolution.variables?.resolution === null ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Reopen feedback
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    disabled={setResolution.isPending}
                    onClick={() => void updateResolution("dismissed")}
                  >
                    {setResolution.isPending &&
                    setResolution.variables?.resolution === "dismissed" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Dismiss
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="success"
                    disabled={setResolution.isPending}
                    onClick={() => void updateResolution("fixed")}
                  >
                    {setResolution.isPending &&
                    setResolution.variables?.resolution === "fixed" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Mark fixed
                  </Button>
                </div>
              )}
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThreadMessage({
  message,
  grouped,
}: {
  message: ReviewThreadMessage;
  grouped: boolean;
}): JSX.Element {
  const isAgent = message.authorType !== "human";
  const isStateChange =
    message.type === "resolution" || message.type === "reopen";
  const stateChangeLabel =
    message.type === "reopen"
      ? "Reopened feedback"
      : message.content?.resolution
        ? `Marked ${message.content.resolution}`
        : "Updated feedback state";
  const body = isStateChange
    ? message.content?.body
      ? `${stateChangeLabel}\n\n${message.content.body}`
      : stateChangeLabel
    : message.content?.body || "Updated feedback";
  return (
    <div className={cn(grouped ? "mt-1" : "mt-2.5", isAgent ? "pr-6" : "pl-6")}>
      {!grouped && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[10px] text-muted-foreground/75",
            !isAgent && "justify-end"
          )}
        >
          <span className="font-medium">
            {isStateChange ? "State change" : isAgent ? "Agent" : "You"}
          </span>
          <span>·</span>
          <span>
            {new Date(message.createdAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}
      <div
        className={cn(
          !grouped && "mt-0.5",
          "rounded-xl px-2.5 py-1.5",
          isStateChange
            ? "rounded-md border border-border/70 bg-muted/30 text-muted-foreground"
            : isAgent
              ? "rounded-bl-sm bg-muted text-foreground"
              : "rounded-br-sm bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20"
        )}
      >
        <Markdown className="text-xs text-foreground">{body}</Markdown>
      </div>
    </div>
  );
}
