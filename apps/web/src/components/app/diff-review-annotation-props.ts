import { type DraftComment } from "@/components/app/review-mode";
import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

/**
 * The review-annotation half of a diff component's props: draft comments,
 * submitted feedback items, and the callbacks that mutate or focus them.
 *
 * Every component in the diff chain (changes-diff-section -> unified-diff-view
 * -> use-diff-widgets) forwards this same block downward, so it is declared
 * once here and intersected into each component's own props.
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
