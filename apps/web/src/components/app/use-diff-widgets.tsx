import { useMemo } from "react";
import { type FileData } from "react-diff-view";

import { type DraftComment } from "@/components/app/review-mode";
import { InlineCommentForm } from "@/components/app/diff-comment-form";
import { InlineDraftAnnotation } from "@/components/app/diff-draft-annotation";
import { InlineFeedbackAnnotation } from "@/components/app/diff-feedback-annotation";
import {
  findLastChangeKeyInRange,
  type LineSelection,
} from "@/components/app/unified-diff-utils";
import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

type UseDiffWidgetsOptions = {
  file: FileData | null;
  agentId: string | null;
  filePath: string;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  reviewMode?: boolean;
  draftComments?: DraftComment[];
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraft?: (id: string) => void;
  onUpdateDraft?: (id: string, comment: string) => void;
  onStartReview?: () => void;
  feedbackItems?: ReviewFeedbackItem[];
  focusedFeedbackItemId?: number | null;
  onFeedbackFocusComplete?: (feedbackItemId: number) => void;
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
  feedbackItems,
  focusedFeedbackItemId,
  onFeedbackFocusComplete,
}: UseDiffWidgetsOptions): Record<string, React.ReactElement> {
  return useMemo(() => {
    if (!file) return {};
    const w: Record<string, React.ReactElement> = {};

    if (feedbackItems) {
      const grouped = new Map<string, typeof feedbackItems>();
      for (const fi of feedbackItems) {
        if (fi.lineStart == null) continue;
        const key = findLastChangeKeyInRange(
          file.hunks,
          fi.lineStart,
          fi.lineEnd ?? fi.lineStart
        );
        if (!key) continue;
        const list = grouped.get(key) ?? [];
        list.push(fi);
        grouped.set(key, list);
      }
      for (const [key, items] of grouped) {
        w[key] = (
          <>
            {items.map((fi) => {
              const firstMsg = fi.messages[0]?.content?.body ?? "";
              const isResolved = fi.status === "resolved";
              return (
                <InlineFeedbackAnnotation
                  key={fi.id}
                  agentId={agentId}
                  feedbackItem={fi}
                  comment={firstMsg}
                  isResolved={isResolved}
                  focused={fi.id === focusedFeedbackItemId}
                  onFocusComplete={onFeedbackFocusComplete}
                />
              );
            })}
          </>
        );
      }
    }

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
    feedbackItems,
    focusedFeedbackItemId,
    onFeedbackFocusComplete,
  ]);
}
