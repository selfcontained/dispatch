import { memo, useCallback, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquarePlus,
  Send,
  X,
} from "lucide-react";

import { useSubmitReview } from "@/hooks/use-agent-reviews";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

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
  onExitReview: () => void;
  onReviewSubmitted: () => void;
};

export const ReviewModeBar = memo(function ReviewModeBar({
  agentId,
  drafts,
  onClearDrafts,
  onExitReview,
  onReviewSubmitted,
}: ReviewModeBarProps): JSX.Element {
  const [submitOpen, setSubmitOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const handleCancel = useCallback(() => {
    if (drafts.length > 0) {
      setCancelOpen(true);
    } else {
      onExitReview();
    }
  }, [drafts.length, onExitReview]);

  const handleConfirmCancel = useCallback(() => {
    onClearDrafts();
    onExitReview();
    setCancelOpen(false);
  }, [onClearDrafts, onExitReview]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
        <MessageSquarePlus className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-foreground">Review Mode</span>
        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {drafts.length} comment{drafts.length !== 1 ? "s" : ""}
        </span>
        <div className="flex-1" />
        {drafts.length > 0 && (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setSubmitOpen(true)}
          >
            <Send className="h-3 w-3" />
            Submit review
          </button>
        )}
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={handleCancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <SubmitReviewDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        agentId={agentId}
        drafts={drafts}
        onClearDrafts={onClearDrafts}
        onReviewSubmitted={onReviewSubmitted}
      />

      <CancelReviewDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        draftCount={drafts.length}
        onConfirm={handleConfirmCancel}
      />
    </>
  );
});

function SubmitReviewDialog({
  open,
  onOpenChange,
  agentId,
  drafts,
  onClearDrafts,
  onReviewSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  drafts: DraftComment[];
  onClearDrafts: () => void;
  onReviewSubmitted: () => void;
}): JSX.Element {
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
      onOpenChange(false);
      onReviewSubmitted();
    } catch {
      // error handling via mutation state
    }
  }, [
    drafts,
    summary,
    submitMutation,
    onClearDrafts,
    onReviewSubmitted,
    onOpenChange,
  ]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-sm">Submit Review</DialogTitle>
          <DialogDescription>
            {drafts.length} comment{drafts.length !== 1 ? "s" : ""} will be sent
            to the agent.
          </DialogDescription>
        </DialogHeader>
        <textarea
          ref={textareaRef}
          className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Review summary (optional)…"
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {submitMutation.isError && (
          <p className="text-xs text-status-blocked">
            Failed to submit review. Please try again.
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
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
            Submit
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CancelReviewDialog({
  open,
  onOpenChange,
  draftCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftCount: number;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-sm">Discard review?</DialogTitle>
          <DialogDescription>
            You have {draftCount} draft comment{draftCount !== 1 ? "s" : ""}.
            Discarding will remove all comments.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
            onClick={() => onOpenChange(false)}
          >
            Keep reviewing
          </button>
          <button
            type="button"
            className="rounded bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Discard
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
