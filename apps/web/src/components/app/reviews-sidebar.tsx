import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
  const [expandedReviewId, setExpandedReviewId] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: diffData } = useAgentDiff(agentId, !!agentId);

  useEffect(() => {
    const expandReview = searchParams.get("expandReview");
    if (expandReview != null) {
      setExpandedReviewId(parseInt(expandReview, 10));
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("expandReview");
          return next;
        },
        { replace: true }
      );
    }
  }, [searchParams, setSearchParams]);

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
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
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
        "relative mb-3 overflow-clip rounded-md border-l-2 bg-muted/[0.07]",
        statusStyle.rail
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 overflow-hidden rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
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
          <p
            className={cn(
              "text-xs text-foreground/90",
              !expanded && "truncate",
              !review.summary && "text-muted-foreground"
            )}
          >
            {review.summary || "Review feedback"}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <MessageCircle className="h-2.5 w-2.5" />
              {review.resolvedCount}/{review.itemCount} resolved
            </span>
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
            <div className="px-1.5 pb-2 pt-1">
              {review.status === "open" && (
                <p className="mb-2 px-1 text-[10px] text-muted-foreground">
                  Sent to agent — waiting for response · {timeStr}
                </p>
              )}
              {detail ? (
                detail.items.map((item) => (
                  <FeedbackItemRow
                    key={item.id}
                    agentId={agentId}
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
          "group relative rounded-md bg-muted/15 px-2.5 py-2.5 text-left",
          !expanded && "transition-colors hover:bg-muted/35",
          expanded &&
            "sticky top-0 z-10 isolate rounded-b-none bg-card shadow-sm before:pointer-events-none before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:bg-card"
        )}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} feedback`}
            className="flex shrink-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          </button>
          {item.filePath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "block min-w-0 truncate font-mono text-[10px]",
                    fileInDiff
                      ? "text-primary hover:underline"
                      : "cursor-default text-muted-foreground"
                  )}
                  onClick={handleFileClick}
                >
                  {compactPathLabel}
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
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "mt-1.5 block w-full rounded-sm pl-5 pr-2 text-left whitespace-pre-wrap break-words text-xs leading-[1.45] text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !expanded && "line-clamp-2"
          )}
        >
          {originalFeedback}
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
              {item.diffSnapshot && (
                <ReviewDiffSnapshot diff={item.diffSnapshot} className="mt-0" />
              )}
              {item.messages.slice(1).map((message, index, messages) => (
                <ThreadMessage
                  key={message.id}
                  message={message}
                  grouped={
                    index > 0 &&
                    messages[index - 1]?.authorType === message.authorType
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
  return (
    <div className={cn(grouped ? "mt-1" : "mt-2.5", isAgent ? "pr-6" : "pl-6")}>
      {!grouped && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[10px] text-muted-foreground/75",
            !isAgent && "justify-end"
          )}
        >
          <span className="font-medium">{isAgent ? "Agent" : "You"}</span>
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
          isAgent
            ? "rounded-bl-sm bg-muted text-foreground"
            : "rounded-br-sm bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20"
        )}
      >
        <Markdown className="text-xs text-foreground">
          {message.content?.body ?? ""}
        </Markdown>
      </div>
    </div>
  );
}
