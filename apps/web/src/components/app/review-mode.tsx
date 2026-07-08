import { memo, useCallback, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";

import { useSubmitReview } from "@/hooks/use-agent-reviews";

export type DraftComment = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  comment: string;
};

type ReviewModeBarProps = {
  agentId: string;
  drafts: DraftComment[];
  onClearDrafts: () => void;
  onRemoveDraft: (id: string) => void;
  onExitReview: () => void;
  onReviewSubmitted: () => void;
};

export const ReviewModeBar = memo(function ReviewModeBar({
  agentId,
  drafts,
  onClearDrafts,
  onRemoveDraft,
  onExitReview,
  onReviewSubmitted,
}: ReviewModeBarProps): JSX.Element {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const submitMutation = useSubmitReview(agentId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    if (drafts.length === 0) return;
    try {
      await submitMutation.mutateAsync({
        summary: summary.trim() || undefined,
        items: drafts.map((d) => ({
          filePath: d.filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          comment: d.comment,
        })),
      });
      onClearDrafts();
      setSummary("");
      setSummaryOpen(false);
      onReviewSubmitted();
    } catch {
      // error handling via mutation state
    }
  }, [drafts, summary, submitMutation, onClearDrafts, onReviewSubmitted]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="border-b border-border/50 bg-muted/30">
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageSquarePlus className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-foreground">Review Mode</span>
        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {drafts.length} comment{drafts.length !== 1 ? "s" : ""}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onClearDrafts();
            onExitReview();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {drafts.length > 0 && (
        <div className="border-t border-border/30 px-3 py-1.5 space-y-1">
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="flex items-start gap-2 rounded px-2 py-1 text-xs hover:bg-muted/30 group"
            >
              <span className="font-mono text-muted-foreground shrink-0">
                {draft.filePath.split("/").pop()}:{draft.startLine}
                {draft.endLine !== draft.startLine ? `-${draft.endLine}` : ""}
              </span>
              <span className="flex-1 truncate text-foreground/80">
                {draft.comment}
              </span>
              <button
                type="button"
                onClick={() => onRemoveDraft(draft.id)}
                className="shrink-0 text-muted-foreground hover:text-status-blocked opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {summaryOpen && (
        <div className="border-t border-border/30 px-3 py-2">
          <textarea
            ref={textareaRef}
            className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Review summary (optional)…"
            rows={2}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
      )}

      {drafts.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border/30 px-3 py-2">
          {!summaryOpen && (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setSummaryOpen(true)}
            >
              <Pencil className="h-3 w-3" />
              Add summary
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : submitMutation.isSuccess ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Submit review
          </button>
        </div>
      )}
      {submitMutation.isError && (
        <div className="px-3 pb-2 text-xs text-status-blocked">
          Failed to submit review. Please try again.
        </div>
      )}
    </div>
  );
});

type DraftCommentWidgetProps = {
  filePath: string;
  startLine: number;
  endLine: number;
  onSave: (comment: string) => void;
  onCancel: () => void;
  existingComment?: string;
};

export function DraftCommentWidget({
  filePath,
  startLine,
  endLine,
  onSave,
  onCancel,
  existingComment,
}: DraftCommentWidgetProps): JSX.Element {
  const [comment, setComment] = useState(existingComment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lineLabel =
    startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (comment.trim()) onSave(comment.trim());
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [comment, onSave, onCancel]
  );

  return (
    <div className="border-t border-border/50 bg-muted/20 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <MessageSquarePlus className="h-3 w-3" />
        <span className="font-mono">{filePath}</span>
        <span>·</span>
        <span>{lineLabel}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Add review comment…"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
          onClick={onCancel}
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={() => {
            if (comment.trim()) onSave(comment.trim());
          }}
          disabled={!comment.trim()}
        >
          <MessageSquarePlus className="h-3 w-3" />
          Add comment
        </button>
      </div>
    </div>
  );
}
