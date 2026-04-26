import type { PersonaReviewResolutionItem } from "../agents/manager.js";

/**
 * First user message handed to a freshly-launched persona agent. The persona
 * body, feedback guidance, parent context, and diff to review are already
 * loaded into the launch context — all the agent needs is a "go" signal so it
 * doesn't sit waiting for input on launch.
 */
export function buildPersonaKickoffPrompt(): string {
  return "Begin your review now. Your persona instructions, the parent's context briefing, and the diff to review are already loaded into your context — use them.";
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

export type ReviewerRecheckReadyInput = {
  resolutionSummary: string;
  resolutions: PersonaReviewResolutionItem[];
  diffSincePreviousRound: string;
};

export function buildReviewerRecheckReadyPrompt(
  input: ReviewerRecheckReadyInput
): string {
  const { resolutionSummary, resolutions, diffSincePreviousRound } = input;

  const itemLines = resolutions.length
    ? resolutions
        .map((item) => {
          const location =
            item.filePath && item.lineNumber
              ? ` (${item.filePath}:${item.lineNumber})`
              : item.filePath
                ? ` (${item.filePath})`
                : "";
          const reason = item.reason ? `\n  Reason: ${item.reason}` : "";
          const commit = item.resolutionCommit
            ? `\n  Commit: ${item.resolutionCommit}`
            : "";
          return `- #${item.feedbackId} [${item.originalSeverity}] ${item.status}${location}: ${item.originalDescription}${reason}${commit}`;
        })
        .join("\n")
    : "(no per-item resolutions recorded)";

  const diffBlock = diffSincePreviousRound.trim().length
    ? `\`\`\`diff\n${diffSincePreviousRound}\n\`\`\``
    : "(no diff since your round-1 commit)";

  return [
    "The parent has submitted their resolution for round 1. Begin round 2 now.",
    "",
    "Parent's resolution summary:",
    resolutionSummary,
    "",
    "Per-item resolutions:",
    itemLines,
    "",
    "Diff since your round-1 commit:",
    diffBlock,
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
