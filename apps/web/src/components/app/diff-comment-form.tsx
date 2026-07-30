import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Loader2, MessageSquare } from "lucide-react";

import { agentRoute } from "@/lib/agent-routes";
import { api } from "@/lib/api";
import { stickyAnnotationStyle } from "@/components/app/diff-annotation-style";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
