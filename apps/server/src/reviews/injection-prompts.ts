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
    "When your initial pass is complete, call dispatch_review_submit exactly once with every actionable finding. When feedback items carry the review, omit the summary unless one short (280 characters or fewer), non-duplicative overall takeaway is useful; do not repeat feedback-item details. A concise nonblank summary is required for a clean approval with an empty feedback array.",
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
  summary: string | null;
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
  ];
  if (input.summary) lines.push(`Summary: ${input.summary}`);
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
      input.reviewerAgentId
        ? "Call dispatch_review_list_feedback with this reviewId before acting. Use dispatch_review_add_message for questions and explanations. After fixing an item, post a concise message asking the reviewer to verify the fix; do not resolve persona-review feedback yourself. The reviewer will re-inspect the fix and resolve the item if complete, or leave it open and reply with further instructions. Keep all review discussion in its feedback-item thread."
        : "Call dispatch_review_list_feedback with this reviewId before acting. Use dispatch_review_add_message for questions or explanations, dispatch_review_resolve when an item is fixed or dismissed, and dispatch_review_reopen if a resolved item needs more work. Keep all review discussion in its feedback-item thread."
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
  recipient: "reviewer" | "assignee";
}): string {
  const nextStep =
    input.recipient === "reviewer"
      ? "Re-inspect the claimed fix before deciding. If it fully addresses this item, call dispatch_review_resolve with resolution 'fixed'. If it is incomplete, leave the item open and reply with specific instructions using dispatch_review_add_message. Do not resolve based only on the assignee's claim."
      : "Address any requested work, then use dispatch_review_add_message to ask the reviewer to verify the fix. Do not resolve persona-review feedback yourself.";
  return buildReviewPromptBlock("REVIEW THREAD UPDATE", [
    `Review ID: ${input.reviewId}`,
    `Feedback item ID: ${input.itemId}`,
    `From: ${input.from}`,
    `Message: ${input.body}`,
    `Call dispatch_event with type 'working' before handling this update, then call dispatch_review_list_feedback with this reviewId for full context. ${nextStep} Do not move review discussion to direct agent messages. Finish with dispatch_event type 'done', or 'waiting_user' only after posting a tracked question that needs a reply.`,
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
