import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";
import type { PersistedDraftComment } from "@/lib/store";
import { agentRoute } from "@/lib/agent-routes";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const stickyAnnotationStyle = {
  width: "var(--diff-scroll-w, 100%)",
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
      className="mx-3 my-3 max-w-full overflow-hidden rounded-md border border-border bg-background shadow-sm sticky left-0"
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
  comment,
  isResolved,
  feedbackItem,
}: {
  feedbackItem: ReviewFeedbackItem;
  comment: string;
  isResolved: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(!isResolved);

  const statusLabel = isResolved ? "Resolved" : "Pending";
  const lineLabel =
    feedbackItem.lineStart != null
      ? feedbackItem.lineEnd && feedbackItem.lineEnd !== feedbackItem.lineStart
        ? `Lines ${feedbackItem.lineStart}–${feedbackItem.lineEnd}`
        : `Line ${feedbackItem.lineStart}`
      : null;

  return (
    <div
      className={cn(
        "mx-3 my-3 max-w-full overflow-hidden rounded-md border bg-background shadow-sm cursor-pointer transition-colors sticky left-0",
        isResolved ? "border-border/50 bg-muted/5" : "border-amber-500/40"
      )}
      style={stickyAnnotationStyle}
      onClick={() => setExpanded((v) => !v)}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[11px]",
          isResolved ? "bg-muted/20" : "bg-amber-500/10"
        )}
      >
        <MessageCircle
          className={cn(
            "h-3 w-3 shrink-0",
            isResolved ? "text-muted-foreground" : "text-amber-500"
          )}
        />
        <span className="font-medium text-foreground">Feedback</span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0 text-[10px] font-medium",
            isResolved
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          )}
        >
          {statusLabel}
        </span>
        {lineLabel && (
          <span className="text-muted-foreground">{lineLabel}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
      </div>
      <div className="px-3 py-2">
        <p
          className={cn(
            "whitespace-pre-wrap text-xs text-foreground/80",
            !expanded && "line-clamp-1"
          )}
        >
          {comment}
        </p>
      </div>
      <AnimatePresence initial={false}>
        {expanded &&
          (feedbackItem.messages.length > 1 ||
            feedbackItem.diffSnapshot ||
            feedbackItem.resolution) && (
            <motion.div
              key="feedback-content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="border-t border-border/30 px-3 pb-2">
                {feedbackItem.diffSnapshot && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded border border-border/30 bg-muted/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/70">
                    {feedbackItem.diffSnapshot}
                  </pre>
                )}
                {feedbackItem.messages.slice(1).map((msg) => (
                  <div key={msg.id} className="mt-2">
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
                {feedbackItem.resolution && (
                  <div className="mt-2 rounded border border-border/30 bg-muted/20 px-3 py-2">
                    <div className="text-[10px] font-medium text-muted-foreground">
                      Resolution: {feedbackItem.resolution}
                    </div>
                    {feedbackItem.resolutionNote && (
                      <p className="mt-0.5 text-xs text-foreground/70">
                        {feedbackItem.resolutionNote}
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
        className="mx-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
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
      className="mx-3 my-3 max-w-full overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm sticky left-0"
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
        <p className="whitespace-pre-wrap text-xs text-foreground/80">
          {draft.comment}
        </p>
      </div>
    </div>
  );
}
