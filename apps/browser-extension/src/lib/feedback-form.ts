export interface FeedbackFormState {
  busy: boolean;
  hasSelection: boolean;
  selectedAgentId: string;
  comment: string;
}

export function canSubmitFeedback(state: FeedbackFormState): boolean {
  return (
    !state.busy &&
    state.hasSelection &&
    Boolean(state.selectedAgentId) &&
    Boolean(state.comment.trim())
  );
}
