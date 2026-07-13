import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";
import {
  useAddReviewThreadMessage,
  useSetReviewFeedbackResolution,
  type ReviewThreadMessage,
} from "@/hooks/use-agent-reviews";
import type { PersistedDraftComment } from "@/lib/store";
import { agentRoute } from "@/lib/agent-routes";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/ui/markdown";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const stickyAnnotationStyle = {
  maxWidth: "calc(var(--diff-scroll-w, 100%) - 1.5rem)",
};

export function InlineCommentForm({
  agentId,
  filePath,
  startLine,
  endLine,
  onCancel,
  onSubmitted,
  reviewMode,
  onStartReview,
  onAddDraft,
}: {
  agentId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  onCancel: () => void;
  onSubmitted: () => void;
  reviewMode?: boolean;
  onStartReview?: () => void;
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
}): JSX.Element {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lineLabel =
    startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;

  const handleChat = useCallback(async () => {
    if (!comment.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api(`/api/v1/agents/${agentId}/diff/comment`, {
        method: "POST",
        body: JSON.stringify({ filePath, startLine, endLine, comment }),
      });
      onSubmitted();
      navigate(agentRoute(agentId), { replace: true });
    } catch {
      setSubmitting(false);
    }
  }, [
    agentId,
    comment,
    endLine,
    filePath,
    navigate,
    onSubmitted,
    startLine,
    submitting,
  ]);

  const handleAddDraft = useCallback(() => {
    if (!comment.trim() || !onAddDraft) return;
    onAddDraft(filePath, startLine, endLine, comment.trim());
    onSubmitted();
  }, [comment, filePath, startLine, endLine, onAddDraft, onSubmitted]);

  const handleStartReview = useCallback(() => {
    if (!comment.trim() || !onStartReview || !onAddDraft) return;
    onStartReview();
    onAddDraft(filePath, startLine, endLine, comment.trim());
    onSubmitted();
  }, [
    comment,
    filePath,
    startLine,
    endLine,
    onStartReview,
    onAddDraft,
    onSubmitted,
  ]);

  const handlePrimaryAction = reviewMode ? handleAddDraft : handleStartReview;
  const primaryLabel = reviewMode ? "Add comment" : "Start a review";

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handlePrimaryAction();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handlePrimaryAction, onCancel]
  );

  return (
    <div
      className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-border bg-background shadow-sm sticky left-0"
      style={stickyAnnotationStyle}
    >
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <MessageSquare className="h-3 w-3" />
        <span className="font-medium text-foreground">Add a comment</span>
        <span className="truncate font-mono">{lineLabel}</span>
      </div>
      <div className="p-3">
        <textarea
          ref={textareaRef}
          className="w-full resize-none rounded border border-border bg-muted/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Leave a comment…"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          disabled={submitting}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <DropdownMenu>
            <div className="flex">
              <button
                type="button"
                className="flex items-center gap-1 rounded-l bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={handlePrimaryAction}
                disabled={!comment.trim() || submitting}
              >
                {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {primaryLabel}
              </button>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center rounded-r border-l border-primary-foreground/20 bg-primary px-1.5 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={!comment.trim() || submitting}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
            </div>
            <DropdownMenuContent
              align="end"
              side="top"
              className="min-w-[140px]"
            >
              <DropdownMenuItem onClick={handleChat}>
                <MessageSquare className="mr-2 h-3 w-3" />
                Chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

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
                    <InlineThreadMessage
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
                      <div className="ml-auto grid w-full max-w-sm grid-cols-2 gap-2">
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
                {feedbackItem.resolution && (
                  <div
                    className={cn(
                      "mb-3 rounded border px-3 py-2",
                      feedbackItem.resolution === "fixed"
                        ? "border-status-working/25 bg-status-working/[0.06]"
                        : "border-muted-foreground/25 bg-muted/30"
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-center gap-1 text-[10px] font-medium",
                        feedbackItem.resolution === "fixed"
                          ? "text-status-working"
                          : "text-muted-foreground"
                      )}
                    >
                      {feedbackItem.resolution === "fixed" ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      Resolution: {feedbackItem.resolution}
                    </div>
                    {feedbackItem.resolutionNote && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/80">
                        {feedbackItem.resolutionNote}
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
                    className="ml-auto w-full max-w-48"
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
                  <div className="ml-auto grid w-full max-w-sm grid-cols-2 gap-2">
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
    </TooltipProvider>
  );
}

function InlineThreadMessage({
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

export function InlineDraftAnnotation({
  draft,
  onRemove,
  onUpdate,
}: {
  draft: PersistedDraftComment;
  onRemove?: (id: string) => void;
  onUpdate?: (id: string, comment: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(draft.comment);

  const handleSave = useCallback(() => {
    if (editValue.trim() && onUpdate) {
      onUpdate(draft.id, editValue.trim());
    }
    setEditing(false);
  }, [draft.id, editValue, onUpdate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditValue(draft.comment);
        setEditing(false);
      }
    },
    [handleSave, draft.comment]
  );

  const lineLabel =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;

  if (editing) {
    return (
      <div
        className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
        style={stickyAnnotationStyle}
      >
        <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
          <MessageSquarePlus className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">Edit draft</span>
        </div>
        <div className="p-3">
          <textarea
            className="w-full resize-none rounded border border-border bg-muted/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={3}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleSave}
              disabled={!editValue.trim()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ml-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
      style={stickyAnnotationStyle}
    >
      <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
        <MessageSquarePlus className="h-3 w-3 text-primary" />
        <span className="font-medium text-foreground">Draft</span>
        <span className="rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          Pending
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center rounded min-h-8 min-w-8 p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            <DropdownMenuItem
              className="text-foreground"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(true);
              }}
            >
              <Pencil className="mr-2 h-3 w-3" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRemove?.(draft.id)}>
              <Trash2 className="mr-2 h-3 w-3" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs text-foreground/80">
          {draft.comment}
        </p>
      </div>
    </div>
  );
}
