import { describe, it, expect } from "vitest";

import {
  buildParentRound1FeedbackPrompt,
  buildParentReviewCompletePrompt,
  buildPersonaKickoffPrompt,
  buildReviewerRecheckCancelledPrompt,
  buildReviewerRecheckReadyPrompt,
} from "../src/reviews/injection-prompts.js";

describe("buildPersonaKickoffPrompt", () => {
  it("nudges the agent to begin and references the loaded context", () => {
    const text = buildPersonaKickoffPrompt();
    expect(text).toMatch(/begin your review/i);
    expect(text).toMatch(/loaded into your context/i);
  });
});

describe("buildParentRound1FeedbackPrompt", () => {
  it("includes the persona name, agent id, verdict, and item count", () => {
    const text = buildParentRound1FeedbackPrompt({
      persona: "backend-security-review",
      personaAgentId: "agt_reviewer",
      verdict: "request_changes",
      feedbackCount: 3,
    });

    expect(text).toContain('"backend-security-review"');
    expect(text).toContain("agt_reviewer");
    expect(text).toContain("request_changes");
    expect(text).toContain("3 feedback item");
  });

  it("instructs the parent to commit before submitting resolution", () => {
    const text = buildParentRound1FeedbackPrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "request_changes",
      feedbackCount: 1,
    });
    expect(text).toMatch(/commit your fixes before submitting/i);
  });

  it("falls back to a no-findings nudge when feedbackCount is 0", () => {
    const text = buildParentRound1FeedbackPrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "approve",
      feedbackCount: 0,
    });
    expect(text).toMatch(/no findings/i);
    expect(text).toContain("dispatch_submit_resolution");
    expect(text).toContain("dispatch_cancel_recheck");
  });

  it("does not reference the removed await tools", () => {
    const text = buildParentRound1FeedbackPrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "approve",
      feedbackCount: 0,
    });
    expect(text).not.toContain("dispatch_await_review");
    expect(text).not.toContain("dispatch_await_recheck");
  });
});

describe("buildParentReviewCompletePrompt", () => {
  it("labels round 2 explicitly", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "approve",
      summary: "All good",
      feedbackCount: 0,
      roundNumber: 2,
    });
    expect(text).toContain("round 2");
    expect(text).toContain("complete");
  });

  it("uses generic 'the review' wording for single-pass round 1", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "approve",
      summary: "All good",
      feedbackCount: 0,
      roundNumber: 1,
    });
    expect(text).toContain("the review");
    expect(text).not.toContain("round 2");
  });

  it("includes a read-feedback hint when items were recorded", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "request_changes",
      summary: "Found something",
      feedbackCount: 4,
      roundNumber: 2,
    });
    expect(text).toContain("4 feedback item");
    expect(text).toContain("dispatch_get_feedback");
  });

  it("tells Cursor parents to reply to reviewers after requested changes", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "mobile-ux",
      personaAgentId: "agt_reviewer",
      verdict: "request_changes",
      summary: "Still needs work",
      feedbackCount: 2,
      roundNumber: 2,
      cursorRuntime: true,
    });

    expect(text).toContain("dispatch_send_message");
    expect(text).toContain("reply to reviewer agent agt_reviewer");
    expect(text).toContain("fix commit");
    expect(text).toContain("resolved feedback IDs");
    expect(text).toContain("no further recheck round is available");
  });

  it("does not add the reviewer reply nudge for non-Cursor parents", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "mobile-ux",
      personaAgentId: "agt_reviewer",
      verdict: "request_changes",
      summary: "Still needs work",
      feedbackCount: 2,
      roundNumber: 2,
    });

    expect(text).not.toContain("dispatch_send_message");
  });

  it("does not add the reviewer reply nudge for Cursor approvals", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "mobile-ux",
      personaAgentId: "agt_reviewer",
      verdict: "approve",
      summary: "All good",
      feedbackCount: 0,
      roundNumber: 2,
      cursorRuntime: true,
    });

    expect(text).not.toContain("dispatch_send_message");
  });

  it("nudges the parent to wrap up", () => {
    const text = buildParentReviewCompletePrompt({
      persona: "p",
      personaAgentId: "agt_x",
      verdict: "approve",
      summary: "All good",
      feedbackCount: 0,
      roundNumber: 2,
    });
    expect(text).toMatch(/wrap up/i);
    expect(text).toMatch(/dispatch_event/);
  });
});

describe("buildReviewerRecheckReadyPrompt", () => {
  it("tells the reviewer to fetch context and inspect the diff locally", () => {
    const text = buildReviewerRecheckReadyPrompt();
    expect(text).toContain("dispatch_get_recheck_context");
    expect(text).toMatch(/git diff/i);
  });

  it("tells the reviewer to call dispatch_complete_review for round 2", () => {
    const text = buildReviewerRecheckReadyPrompt();
    expect(text).toContain("dispatch_complete_review");
    expect(text).toContain("respondsToFeedbackId");
  });

  it("does not reference any removed polling tool", () => {
    const text = buildReviewerRecheckReadyPrompt();
    expect(text).not.toContain("dispatch_await_recheck");
    expect(text).not.toContain("dispatch_await_review");
  });
});

describe("buildReviewerRecheckCancelledPrompt", () => {
  it("conveys cancellation and the supplied reason", () => {
    const text = buildReviewerRecheckCancelledPrompt({
      reason: "shipping without recheck",
    });
    expect(text).toMatch(/cancelled/i);
    expect(text).toContain("shipping without recheck");
    expect(text).toMatch(/wrap up cleanly/i);
  });

  it("falls back gracefully when no reason was provided", () => {
    const text = buildReviewerRecheckCancelledPrompt({ reason: null });
    expect(text).toMatch(/no reason was provided/i);
  });
});
