import { memo, useCallback, useState } from "react";
import type {
  BlockReviewInput,
  BlockFindingData,
  BlockReviewSeverity,
} from "@dispatch/shared";
import { CheckCircle2, MessageSquarePlus, Send, Trash2, X } from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";

export type DraftComment = PersistedDraftComment;

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
export function draftToFinding(draft: DraftComment): BlockFindingData {
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
    severity: draft.severity ?? "minor",
    title,
    body: draft.comment,
    path: draft.filePath,
    line: draft.startLine,
  };
}

/** The review block a hand-written review becomes. */
export function draftsToReview(
  summary: string,
  drafts: readonly DraftComment[]
): BlockReviewInput {
  return { summary, findings: drafts.map(draftToFinding) };
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
        className="flex items-center gap-2 border-b border-border-subtle bg-surface-subtle px-3 py-2"
        data-testid="review-mode-bar"
      >
        <MessageSquarePlus className="h-3.5 w-3.5 text-primary" />
        <span className="text-body-sm font-medium text-foreground">
          Review mode
        </span>
        <Badge size="sm" tone="info" data-testid="review-mode-count">
          {drafts.length} comment{drafts.length !== 1 ? "s" : ""}
        </Badge>
        <span className="hidden text-label-sm text-muted-foreground sm:inline">
          Select lines in the diff to add a comment.
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="primary"
          size="xs"
          disabled={rootId === null}
          data-testid="review-mode-submit"
          onClick={() => setSubmitOpen(true)}
        >
          <Send />
          Post review
        </Button>
        <IconButton size="icon-sm" label="Cancel review" onClick={handleCancel}>
          <X />
        </IconButton>
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
  const post = usePostBlock(rootId);
  const { mutateAsync: postAsync, isPending, isError, error, reset } = post;
  const canSubmit = summary.trim().length > 0 && !isPending;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const review = draftsToReview(summary.trim(), drafts);
    try {
      const result = await postAsync({
        to: agentId,
        text: "",
        review,
      });
      onClearDrafts();
      setSummary("");
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
      <DialogContent data-testid="submit-review-dialog" busy={isPending}>
        <DialogHeader>
          <DialogTitle>Post review</DialogTitle>
          <DialogDescription>
            Posts a review block into the agent&apos;s stream. Each comment
            becomes a finding with its own thread; the agent answers under it
            and you resolve it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label="Summary">
            <Textarea
              className="w-full resize-none text-body-sm"
              placeholder="Summary — what you looked at and what you think overall…"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              data-testid="review-summary"
            />
          </Field>
          {drafts.length > 0 ? (
            <ol
              className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle"
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
                      className="h-7 w-[6.5rem] shrink-0 text-label-sm"
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
                    <div className="truncate font-mono text-label-xs text-muted-foreground">
                      {draft.filePath}:{draft.startLine}
                      {draft.endLine !== draft.startLine
                        ? `–${draft.endLine}`
                        : ""}
                    </div>
                    <div className="line-clamp-2 text-body-sm text-foreground">
                      {draft.comment}
                    </div>
                  </div>
                  <IconButton
                    size="icon-sm"
                    label="Remove comment"
                    onClick={() => onRemoveDraft(draft.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-body-sm text-muted-foreground">
              No line comments. The review posts with the summary alone.
            </p>
          )}
        </DialogBody>
        {isError ? (
          <Alert title="Couldn’t post the review." error={error} />
        ) : null}
        <DialogFooter>
          <DialogCancel />
          <Button
            type="button"
            variant="primary"
            onClick={() => void handleSubmit()}
            pending={isPending}
            disabled={!canSubmit}
            data-testid="review-post"
          >
            {post.isSuccess ? <CheckCircle2 /> : <Send />}
            Post review
          </Button>
        </DialogFooter>
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
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Discard review?"
      description={`You have ${draftCount} draft comment${draftCount !== 1 ? "s" : ""}. Discarding will remove all comments.`}
      cancelLabel="Keep reviewing"
      confirmLabel="Discard review"
      errorTitle="Couldn’t discard the review."
      onConfirm={onConfirm}
    />
  );
}
