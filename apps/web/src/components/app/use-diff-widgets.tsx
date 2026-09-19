import { useMemo } from "react";
import { type FileData } from "react-diff-view";

import type { DiffReviewAnnotationProps } from "@/components/app/diff-review-annotation-props";
import { InlineCommentForm } from "@/components/app/diff-comment-form";
import { InlineDraftAnnotation } from "@/components/app/diff-draft-annotation";
import {
  findLastChangeKeyInRange,
  type LineSelection,
} from "@/components/app/unified-diff-utils";

type UseDiffWidgetsOptions = DiffReviewAnnotationProps & {
  file: FileData | null;
  agentId: string | null;
  filePath: string;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
};

export function useDiffWidgets({
  file,
  agentId,
  filePath,
  lineSelection,
  onLineSelection,
  commentOpen,
  onCommentOpen,
  reviewMode,
  draftComments,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onStartReview,
}: UseDiffWidgetsOptions): Record<string, React.ReactElement> {
  return useMemo(() => {
    if (!file) return {};
    const w: Record<string, React.ReactElement> = {};

    if (draftComments) {
      for (const draft of draftComments) {
        const key = findLastChangeKeyInRange(
          file.hunks,
          draft.startLine,
          draft.endLine
        );
        if (!key) continue;
        const draftWidget = (
          <InlineDraftAnnotation
            draft={draft}
            onRemove={onRemoveDraft}
            onUpdate={onUpdateDraft}
          />
        );
        const existing = w[key];
        w[key] = existing ? (
          <>
            {existing}
            {draftWidget}
          </>
        ) : (
          draftWidget
        );
      }
    }

    if (lineSelection && agentId && commentOpen) {
      const lastKey = findLastChangeKeyInRange(
        file.hunks,
        lineSelection.startLine,
        lineSelection.endLine
      );
      if (lastKey) {
        w[lastKey] = (
          <InlineCommentForm
            agentId={agentId}
            filePath={filePath}
            startLine={lineSelection.startLine}
            endLine={lineSelection.endLine}
            reviewMode={reviewMode}
            onStartReview={onStartReview}
            onAddDraft={onAddDraft}
            onCancel={() => {
              onCommentOpen(false);
              onLineSelection(null);
            }}
            onSubmitted={() => {
              onCommentOpen(false);
              onLineSelection(null);
            }}
          />
        );
      }
    }

    return w;
  }, [
    file,
    lineSelection,
    agentId,
    filePath,
    onLineSelection,
    commentOpen,
    onCommentOpen,
    reviewMode,
    onStartReview,
    draftComments,
    onAddDraft,
    onRemoveDraft,
    onUpdateDraft,
  ]);
}
