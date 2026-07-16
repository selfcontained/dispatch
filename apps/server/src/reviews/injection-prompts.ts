/**
 * First user message handed to a freshly-launched persona agent. The persona
 * body, feedback guidance, parent context, and diff to review are already
 * loaded into the launch context — all the agent needs is a "go" signal so it
 * doesn't sit waiting for input on launch.
 */
export function buildPersonaKickoffPrompt(): string {
  return buildReviewPromptBlock("REVIEW ASSIGNMENT", [
    "Begin your review now. Your persona instructions, the parent's context briefing, and the diff to review are already loaded into your context.",
    "Before inspecting the target, call dispatch_event with type 'working' and a short description of the review phase. Refresh that working event whenever you move to a distinct review phase so your parent can see accurate progress.",
    "Inspect the full review target before submitting. Do not use direct agent messages for review discussion.",
    "When your initial pass is complete, call dispatch_review_submit exactly once with a concise summary and every actionable finding. The feedback array may be empty for a clean approval, but the summary is always required.",
    "After submission, use dispatch_review_add_message for clarifying questions or replies on an existing feedback item. Use dispatch_review_add_feedback only for a genuinely new concern.",
    "Immediately after dispatch_review_submit, call dispatch_event with type 'done' if your pass is complete, or 'waiting_user' only when a tracked feedback thread needs a reply. Never leave your status as 'working' while waiting. Later thread activity will be delivered in a new injected review block.",
  ]);
}

const DISPATCH_PROMPT_MARKER_PATTERN = /---\s*(?:END\s+)?DISPATCH\s*:/gi;

function escapeDispatchPromptMarkers(value: string): string {
  return value.replace(DISPATCH_PROMPT_MARKER_PATTERN, "[DISPATCH MARKER]");
}

export function buildReviewPromptBlock(kind: string, lines: string[]): string {
  return [
    `--- DISPATCH: ${kind} ---`,
    ...lines.map(escapeDispatchPromptMarkers),
    `--- END DISPATCH: ${kind} ---`,
  ].join("\n");
}

export function buildReviewSubmittedPrompt(input: {
  reviewId: number;
  reviewerName: string;
  reviewerAgentId?: string | null;
  summary: string;
  items: Array<{
    id: number;
    filePath: string | null;
    lineStart: number | null;
    body: string;
  }>;
}): string {
  const lines = [
    `Review ID: ${input.reviewId}`,
    `Reviewer: ${input.reviewerName}${input.reviewerAgentId ? ` (agent ${input.reviewerAgentId})` : ""}`,
    `Result: ${input.items.length === 0 ? "Approved — no feedback items" : `${input.items.length} feedback item(s) submitted`}`,
    `Summary: ${input.summary}`,
  ];
  if (input.items.length === 0) {
    lines.push(
      "No action is required. This clean approval is recorded as a resolved review."
    );
  } else {
    lines.push("Feedback items:");
    for (const item of input.items) {
      const location = item.filePath
        ? `${item.filePath}${item.lineStart ? `:${item.lineStart}` : ""}`
        : "General";
      lines.push(`- #${item.id} ${location} — ${item.body}`);
    }
    lines.push(
      "Call dispatch_review_list_feedback with this reviewId before acting. Use dispatch_review_add_message for questions or explanations, dispatch_review_resolve when an item is fixed or dismissed, and dispatch_review_reopen if a resolved item needs more work. Keep all review discussion in its feedback-item thread."
    );
  }
  return buildReviewPromptBlock("REVIEW SUBMITTED", lines);
}

export function buildReviewFeedbackAddedPrompt(input: {
  reviewId: number;
  itemId: number;
  reviewerName: string;
  body: string;
}): string {
  return buildReviewPromptBlock("REVIEW FEEDBACK ADDED", [
    `Review ID: ${input.reviewId}`,
    `Feedback item ID: ${input.itemId}`,
    `From: ${input.reviewerName}`,
    `Finding: ${input.body}`,
    "Call dispatch_event with type 'working' before handling this update, then call dispatch_review_list_feedback with this reviewId to refresh the review. Keep questions and explanations in this item's thread. Finish with dispatch_event type 'done', or 'waiting_user' only after posting a tracked question that needs a reply.",
  ]);
}

export function buildReviewThreadUpdatePrompt(input: {
  reviewId: number;
  itemId: number;
  from: string;
  body: string;
}): string {
  return buildReviewPromptBlock("REVIEW THREAD UPDATE", [
    `Review ID: ${input.reviewId}`,
    `Feedback item ID: ${input.itemId}`,
    `From: ${input.from}`,
    `Message: ${input.body}`,
    "Call dispatch_event with type 'working' before handling this update, then call dispatch_review_list_feedback with this reviewId for full context. Reply with dispatch_review_add_message only when useful; do not move review discussion to direct agent messages. Finish with dispatch_event type 'done', or 'waiting_user' only after posting a tracked question that needs a reply.",
  ]);
}

export function buildReviewItemStatePrompt(input: {
  reviewId: number;
  itemId: number;
  action: "resolved" | "reopened";
  resolution?: "fixed" | "dismissed" | null;
  note?: string | null;
}): string {
  const kind =
    input.action === "resolved"
      ? "REVIEW ITEM RESOLVED"
      : "REVIEW ITEM REOPENED";
  const lines = [
    `Review ID: ${input.reviewId}`,
    `Feedback item ID: ${input.itemId}`,
    `State: ${input.action}${input.resolution ? ` (${input.resolution})` : ""}`,
  ];
  if (input.note) lines.push(`Message: ${input.note}`);
  lines.push(
    "Call dispatch_event with type 'working' before handling this update, then call dispatch_review_list_feedback with this reviewId for the current thread. Use dispatch_review_add_message if clarification is needed. Finish with dispatch_event type 'done', or 'waiting_user' only after posting a tracked question that needs a reply."
  );
  return buildReviewPromptBlock(kind, lines);
}

export type ParentRound1FeedbackInput = {
  persona: string;
  personaAgentId: string;
  verdict: string;
  feedbackCount: number;
};

export function buildParentRound1FeedbackPrompt(
  input: ParentRound1FeedbackInput
): string {
  const { persona, personaAgentId, verdict, feedbackCount } = input;
  const noFindings = feedbackCount === 0;
  const headline = noFindings
    ? `Reviewer "${persona}" (agent ${personaAgentId}) finished round 1 with verdict ${verdict} and no findings.`
    : `Reviewer "${persona}" (agent ${personaAgentId}) finished round 1 with verdict ${verdict}. ${feedbackCount} feedback item(s) are ready.`;

  if (noFindings) {
    return [
      headline,
      "",
      `Call dispatch_submit_resolution (personaAgentId="${personaAgentId}") with a brief note so the reviewer can wrap up — or call dispatch_cancel_recheck if you want to abort the round trip. Either way, do not exit yet; the reviewer is waiting.`,
    ].join("\n");
  }

  return [
    headline,
    "",
    "Next steps:",
    `1. Call dispatch_get_feedback (personaAgentId="${personaAgentId}") to read the items.`,
    "2. For each item, decide if you'll fix it or ignore it. Apply the fix, then call dispatch_resolve_feedback (status 'fixed' or 'ignored' — include a 'reason' for any you ignore).",
    "3. Commit your fixes BEFORE submitting the resolution — dispatch_submit_resolution captures the current HEAD as the resolution commit, and the reviewer's round-2 diff is computed from that commit.",
    `4. Call dispatch_submit_resolution (personaAgentId="${personaAgentId}", summary=…). The reviewer will receive a terminal prompt to start round 2.`,
  ].join("\n");
}

export type ParentReviewCompleteInput = {
  persona: string;
  personaAgentId: string;
  verdict: string;
  summary: string;
  feedbackCount: number;
  roundNumber: number;
};

export function buildParentReviewCompletePrompt(
  input: ParentReviewCompleteInput
): string {
  const {
    persona,
    personaAgentId,
    verdict,
    summary,
    feedbackCount,
    roundNumber,
  } = input;
  const roundLabel = roundNumber >= 2 ? "round 2" : "the review";
  const findingsLine =
    feedbackCount > 0
      ? `${feedbackCount} feedback item(s) recorded — read with dispatch_get_feedback (personaAgentId="${personaAgentId}").`
      : "No feedback items were recorded.";

  return [
    `Reviewer "${persona}" (agent ${personaAgentId}) finished ${roundLabel} with verdict ${verdict}. The review is now complete.`,
    "",
    `Summary: ${summary}`,
    "",
    findingsLine,
    "",
    "Wrap up your work and emit a terminal dispatch_event when you're done.",
  ].join("\n");
}

export function buildReviewerRecheckReadyPrompt(): string {
  return [
    "The parent has submitted their resolution for round 1. Begin round 2 now.",
    "",
    "First, call dispatch_get_recheck_context to load the parent's resolution summary, the per-item resolutions, and the exact commit range to inspect.",
    "Then run the returned git diff command locally in your worktree instead of waiting for an injected diff blob.",
    "",
    "Next steps:",
    "1. Re-evaluate each original finding against what the parent actually did. For every original concern that remains unresolved, submit a new dispatch_feedback item with respondsToFeedbackId set to the original feedback item's ID.",
    "2. If the parent addressed everything, submit no new feedback and approve.",
    "3. Call dispatch_complete_review with your round-2 verdict and a fresh summary. The review is not closed until you do this.",
    "4. Emit a terminal dispatch_event (type 'done' or 'idle') after dispatch_complete_review.",
  ].join("\n");
}

export type ReviewerRecheckCancelledInput = {
  reason: string | null;
};

export function buildReviewerRecheckCancelledPrompt(
  input: ReviewerRecheckCancelledInput
): string {
  const reasonLine = input.reason
    ? `Reason: ${input.reason}`
    : "No reason was provided.";
  return [
    "The parent has cancelled this recheck. You do not need to perform a round 2.",
    "",
    reasonLine,
    "",
    "Wrap up cleanly and emit a terminal dispatch_event (type 'done' or 'idle') to signal end of turn.",
  ].join("\n");
}
