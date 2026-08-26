import { type DraftComment } from "@/components/app/review-mode";
import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

/**
 * The review-annotation props threaded from ChangesTab down through DiffPane,
 * FileDiffSection, FileDiffContent, UnifiedDiffView and useDiffWidgets. Every
 * one of those declares the same block, so it lives here once.
 */
export type DiffReviewAnnotationProps = {
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
