import { describe, it, expect } from "vitest";

import {
  buildParentRound1FeedbackPrompt,
  buildParentReviewCompletePrompt,
  buildPersonaKickoffPrompt,
  buildReviewerRecheckCancelledPrompt,
  buildReviewerRecheckReadyPrompt,
  wrapInDiffFence,
} from "../src/reviews/injection-prompts.js";

describe("wrapInDiffFence", () => {
  it("uses a default 3-backtick fence when content has no backticks", () => {
    const text = wrapInDiffFence("+ added\n- removed\n");
    expect(text).toBe("```diff\n+ added\n- removed\n\n```");
  });

  it("uses a longer fence when the diff contains a triple-backtick run", () => {
    const diff = "diff --git a/x.md b/x.md\n+```\n+inner\n+```\n";
    const text = wrapInDiffFence(diff);
    expect(text.startsWith("````diff\n")).toBe(true);
    expect(text.endsWith("\n````")).toBe(true);
    expect(text).toContain("```\n+inner\n+```");
  });

  it("scales with the longest backtick run in the content", () => {
    const diff = "intro `````` outro";
    const text = wrapInDiffFence(diff);
    expect(text.startsWith("```````diff\n")).toBe(true);
    expect(text.endsWith("\n```````")).toBe(true);
  });
});

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
  it("includes summary, per-item resolutions, and diff", () => {
    const text = buildReviewerRecheckReadyPrompt({
      resolutionSummary: "Patched the SQL injection",
      resolutions: [
        {
          feedbackId: 7,
          originalDescription: "Unsanitized input in db.query",
          originalSeverity: "critical",
          status: "fixed",
          reason: null,
          filePath: "apps/server/src/db.ts",
          lineNumber: 42,
          suggestion: null,
          resolutionCommit: "abc123",
          resolvedAt: "2026-04-01T00:00:00Z",
          roundNumber: 1,
        },
      ],
      diffSincePreviousRound: "diff --git a/db.ts b/db.ts\n+sanitize()\n",
    });

    expect(text).toContain("Patched the SQL injection");
    expect(text).toContain("#7 [critical] fixed");
    expect(text).toContain("apps/server/src/db.ts:42");
    expect(text).toContain("Unsanitized input in db.query");
    expect(text).toContain("Commit: abc123");
    expect(text).toContain("```diff");
    expect(text).toContain("sanitize()");
  });

  it("includes the ignored reason when present", () => {
    const text = buildReviewerRecheckReadyPrompt({
      resolutionSummary: "Skipped one finding",
      resolutions: [
        {
          feedbackId: 9,
          originalDescription: "Style nit",
          originalSeverity: "low",
          status: "ignored",
          reason: "out of scope",
          filePath: null,
          lineNumber: null,
          suggestion: null,
          resolutionCommit: null,
          resolvedAt: null,
          roundNumber: 1,
        },
      ],
      diffSincePreviousRound: "",
    });

    expect(text).toContain("#9 [low] ignored");
    expect(text).toContain("Reason: out of scope");
    expect(text).toContain("(no diff since your round-1 commit)");
  });

  it("tells the reviewer to call dispatch_complete_review for round 2", () => {
    const text = buildReviewerRecheckReadyPrompt({
      resolutionSummary: "x",
      resolutions: [],
      diffSincePreviousRound: "",
    });
    expect(text).toContain("dispatch_complete_review");
    expect(text).toContain("respondsToFeedbackId");
    expect(text).toContain("(no per-item resolutions recorded)");
  });

  it("does not reference any removed polling tool", () => {
    const text = buildReviewerRecheckReadyPrompt({
      resolutionSummary: "x",
      resolutions: [],
      diffSincePreviousRound: "",
    });
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
