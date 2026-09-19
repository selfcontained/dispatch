import { memo, useCallback, useState } from "react";
import type {
  BlockReviewData,
  BlockReviewFinding,
  BlockReviewSeverity,
  BlockReviewVerdict,
} from "@dispatch/shared";
import {
  CheckCircle2,
  Loader2,
  MessageSquarePlus,
  Send,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePostBlock } from "@/hooks/use-stream";
import type { PersistedDraftComment } from "@/lib/store";

export type DraftComment = PersistedDraftComment;

const VERDICT_OPTIONS: { value: BlockReviewVerdict; label: string }[] = [
  { value: "comment", label: "Comment" },
  { value: "approve", label: "Approve" },
  { value: "request_changes", label: "Request changes" },
];

export const SEVERITY_OPTIONS: {
  value: BlockReviewSeverity;
  label: string;
}[] = [
  { value: "blocker", label: "Blocker" },
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
  { value: "nit", label: "Nit" },
];

const TITLE_MAX = 120;

/** A draft comment as one finding: its first line is the title. */
export function draftToFinding(draft: DraftComment): BlockReviewFinding {
  const firstLine =
    draft.comment
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? draft.comment.trim();
  const title =
    firstLine.length > TITLE_MAX
      ? `${firstLine.slice(0, TITLE_MAX - 1)}…`
      : firstLine || "Comment";
  return {
    id: draft.id,
    severity: draft.severity ?? "minor",
    title,
    body: draft.comment,
    path: draft.filePath,
    line: draft.startLine,
  };
}

/** The review block a hand-written review becomes. */
export function draftsToReview(
  verdict: BlockReviewVerdict,
  summary: string,
  drafts: readonly DraftComment[]
): BlockReviewData {
  return { verdict, summary, findings: drafts.map(draftToFinding) };
}

type ReviewModeBarProps = {
  /** The agent the review is for. */
  agentId: string;
  /** The root of its lineage: the stream the review is posted into. */
  rootId: string | null;
  drafts: DraftComment[];
  onClearDrafts: () => void;
  onRemoveDraft: (id: string) => void;
  onSetDraftSeverity: (id: string, severity: BlockReviewSeverity) => void;
  onExitReview: () => void;
  /** The posted review block's id. */
  onReviewPosted: (blockId: string) => void;
};

export const ReviewModeBar = memo(function ReviewModeBar({
  agentId,
  rootId,
  drafts,
  onClearDrafts,
  onRemoveDraft,
  onSetDraftSeverity,
  onExitReview,
  onReviewPosted,
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
      <div
        className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2"
        data-testid="review-mode-bar"
      >
        <MessageSquarePlus className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-foreground">Review Mode</span>
        <span
          className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          data-testid="review-mode-count"
        >
          {drafts.length} comment{drafts.length !== 1 ? "s" : ""}
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          Select lines in the diff to add a comment.
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={rootId === null}
          data-testid="review-mode-submit"
          onClick={() => setSubmitOpen(true)}
        >
          <Send className="h-3 w-3" />
          Post review
        </button>
        <button
          type="button"
          aria-label="Cancel review"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={handleCancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {rootId ? (
        <SubmitReviewDialog
          open={submitOpen}
          onOpenChange={setSubmitOpen}
          agentId={agentId}
          rootId={rootId}
          drafts={drafts}
          onRemoveDraft={onRemoveDraft}
          onSetDraftSeverity={onSetDraftSeverity}
          onClearDrafts={onClearDrafts}
          onReviewPosted={onReviewPosted}
        />
      ) : null}

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
  rootId,
  drafts,
  onRemoveDraft,
  onSetDraftSeverity,
  onClearDrafts,
  onReviewPosted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  rootId: string;
  drafts: DraftComment[];
  onRemoveDraft: (id: string) => void;
  onSetDraftSeverity: (id: string, severity: BlockReviewSeverity) => void;
  onClearDrafts: () => void;
  onReviewPosted: (blockId: string) => void;
}): JSX.Element {
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<BlockReviewVerdict>("comment");
  const post = usePostBlock(rootId);
  const { mutateAsync: postAsync, isPending, isError, error, reset } = post;
  const canSubmit = summary.trim().length > 0 && !isPending;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const review = draftsToReview(verdict, summary.trim(), drafts);
    try {
      const result = await postAsync({
        to: agentId,
        text: "",
        review,
      });
      onClearDrafts();
      setSummary("");
      setVerdict("comment");
      onOpenChange(false);
      onReviewPosted(result.block.id);
    } catch {
      // error handling via mutation state
    }
  }, [
    agentId,
    canSubmit,
    drafts,
    onClearDrafts,
    onOpenChange,
    onReviewPosted,
    postAsync,
    summary,
    verdict,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="submit-review-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">Post review</DialogTitle>
          <DialogDescription>
            Posts a review block into the agent&apos;s stream. Each comment
            becomes a finding the agent can resolve or dispute, with a thread
            behind it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label
              htmlFor="review-verdict"
              className="text-xs text-muted-foreground"
            >
              Verdict
            </label>
            <Select
              value={verdict}
              onValueChange={(value) => setVerdict(value as BlockReviewVerdict)}
            >
              <SelectTrigger
                id="review-verdict"
                className="h-8 w-[12rem] text-xs"
                data-testid="review-verdict"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERDICT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            className="w-full resize-none text-xs"
            placeholder="Summary — what you looked at and what you think overall…"
            rows={3}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            data-testid="review-summary"
          />
          {drafts.length > 0 ? (
            <ol
              className="flex max-h-56 flex-col divide-y divide-border/40 overflow-y-auto rounded-md border border-border/50"
              data-testid="review-draft-list"
            >
              {drafts.map((draft) => (
                <li
                  key={draft.id}
                  className="flex items-start gap-2 px-2 py-1.5"
                  data-testid="review-draft"
                >
                  <Select
                    value={draft.severity ?? "minor"}
                    onValueChange={(value) =>
                      onSetDraftSeverity(draft.id, value as BlockReviewSeverity)
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-[6.5rem] shrink-0 text-[11px]"
                      aria-label="Severity"
                      data-testid="review-draft-severity"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEVERITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {draft.filePath}:{draft.startLine}
                      {draft.endLine !== draft.startLine
                        ? `–${draft.endLine}`
                        : ""}
                    </div>
                    <div className="line-clamp-2 text-xs text-foreground">
                      {draft.comment}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    aria-label="Remove comment"
                    onClick={() => onRemoveDraft(draft.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              No line comments. The review posts with the verdict and summary
              alone.
            </p>
          )}
          {isError ? (
            <p className="text-xs text-status-blocked" role="alert">
              Couldn&apos;t post the review: {error.message}
            </p>
          ) : null}
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
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              data-testid="review-post"
            >
              {isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : post.isSuccess ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Post
            </button>
          </div>
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
