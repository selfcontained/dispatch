import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";
import {
  useAddReviewThreadMessage,
  useSetReviewFeedbackResolution,
} from "@/hooks/use-agent-reviews";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import { stickyAnnotationStyle } from "@/components/app/diff-annotation-style";
import {
  FeedbackReplyForm,
  FeedbackResolutionFooter,
  FeedbackThreadMessage,
} from "@/components/app/feedback-card-parts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function InlineFeedbackAnnotation({
  agentId,
  comment,
  isResolved,
  feedbackItem,
  focused = false,
  onFocusComplete,
}: {
  agentId: string | null;
  feedbackItem: ReviewFeedbackItem;
  comment: string;
  isResolved: boolean;
  focused?: boolean;
  onFocusComplete?: (feedbackItemId: number) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const annotationRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const addMessage = useAddReviewThreadMessage(agentId);
  const setResolution = useSetReviewFeedbackResolution(agentId);

  const state = !isResolved
    ? "open"
    : feedbackItem.resolution === "fixed"
      ? "fixed"
      : "dismissed";
  const statusLabel =
    state === "fixed" ? "Fixed" : state === "dismissed" ? "Dismissed" : "Open";
  const statusIcon =
    state === "fixed" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-status-working" />
    ) : state === "dismissed" ? (
      <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
    ) : (
      <Circle className="h-3.5 w-3.5 text-status-waiting" />
    );
  const lineLabel =
    feedbackItem.lineStart != null
      ? feedbackItem.lineEnd && feedbackItem.lineEnd !== feedbackItem.lineStart
        ? `Lines ${feedbackItem.lineStart}–${feedbackItem.lineEnd}`
        : `Line ${feedbackItem.lineStart}`
      : null;

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() => {
      annotationRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    const settleTimer = window.setTimeout(() => {
      annotationRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      onFocusComplete?.(feedbackItem.id);
    }, 220);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [feedbackItem.id, focused, onFocusComplete]);

  const submitReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body) return;
    try {
      await addMessage.mutateAsync({ itemId: feedbackItem.id, body });
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
      await setResolution.mutateAsync({
        itemId: feedbackItem.id,
        resolution,
      });
    } catch {
      toast.error("Couldn't update the feedback state. Try again.");
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={annotationRef}
        data-review-feedback-id={feedbackItem.id}
        className="sticky left-0 my-3 ml-3 max-w-full overflow-clip rounded-md bg-card shadow-sm ring-1 ring-border/50"
        style={stickyAnnotationStyle}
      >
        <div className={cn("px-3 py-2.5", expanded && "bg-muted/20")}>
          <button
            type="button"
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 text-left text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <span className="inline-flex shrink-0">{statusIcon}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{statusLabel}</TooltipContent>
            </Tooltip>
            <span className="font-medium text-foreground">Feedback</span>
            {lineLabel && (
              <span className="text-muted-foreground">{lineLabel}</span>
            )}
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                state === "fixed"
                  ? "bg-status-working/15 text-status-working"
                  : state === "open"
                    ? "bg-status-waiting/15 text-status-waiting"
                    : "bg-muted text-muted-foreground"
              )}
            >
              {statusLabel}
            </span>
          </button>
          <Markdown
            className={cn(
              "mt-1.5 text-xs text-foreground/85",
              !expanded && "line-clamp-2"
            )}
          >
            {comment}
          </Markdown>
        </div>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="feedback-content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeInOut" }}
              className="overflow-clip"
            >
              <div className="ml-5 border-l border-border/70 bg-muted/[0.1] px-3 pb-3 pt-2.5">
                {feedbackItem.messages
                  .slice(1)
                  .map((message, index, messages) => (
                    <FeedbackThreadMessage
                      key={message.id}
                      message={message}
                      grouped={
                        index > 0 &&
                        messages[index - 1]?.authorType ===
                          message.authorType &&
                        messages[index - 1]?.type === message.type
                      }
                    />
                  ))}
                <FeedbackReplyForm
                  replying={replying}
                  reply={reply}
                  isPending={addMessage.isPending}
                  variant="inline"
                  onReplyChange={setReply}
                  onStartReply={() => setReplying(true)}
                  onCancelReply={cancelReply}
                  onSubmit={submitReply}
                />
              </div>
              <FeedbackResolutionFooter
                state={state}
                resolution={feedbackItem.resolution}
                resolutionNote={feedbackItem.resolutionNote}
                isPending={setResolution.isPending}
                pendingResolution={setResolution.variables?.resolution}
                variant="inline"
                onUpdateResolution={(resolution) =>
                  void updateResolution(resolution)
                }
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TooltipProvider>
  );
}
