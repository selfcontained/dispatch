import type { DraftComment } from "@/components/app/review-mode";
import type { ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

/**
 * The review-annotation props threaded from the changes tab down through the
 * diff pane, each file section, the unified diff view and finally the widget
 * hook. Every level in that chain forwards the same optional block, so it is
 * declared once here and intersected into each component's own props.
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
