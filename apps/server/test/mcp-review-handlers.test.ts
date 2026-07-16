import { describe, expect, it, vi } from "vitest";

import { createReviewHandlers } from "../src/server/mcp-review-handlers.js";

vi.mock("../src/shared/git/worktree.js", () => ({
  resolveHeadSha: vi.fn().mockResolvedValue("abc1234"),
}));

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn().mockResolvedValue("/repo"),
  resolveWorktreeRoot: vi.fn().mockResolvedValue("/repo/worktree"),
}));

vi.mock("../src/shared/git/base-ref.js", () => ({
  refreshRemoteBaseRef: vi.fn().mockResolvedValue(undefined),
  resolveBaseRef: vi.fn().mockResolvedValue("origin/main"),
}));

vi.mock("../src/shared/github/pr.js", () => ({
  getPrStatus: vi.fn().mockResolvedValue({ baseRefName: "main" }),
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi
    .fn()
    .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
}));

vi.mock("../src/personas/loader.js", () => ({
  loadPersonas: vi.fn().mockResolvedValue([]),
  loadPersonaBySlug: vi.fn().mockResolvedValue(null),
  assemblePersonaPrompt: vi.fn().mockReturnValue("assembled-prompt"),
}));

vi.mock("../src/personas/review-diff.js", () => ({
  buildPersonaReviewDiff: vi.fn().mockResolvedValue({ diff: "diff-content" }),
}));

vi.mock("../src/reviews/injection-prompts.js", () => ({
  buildParentRound1FeedbackPrompt: vi
    .fn()
    .mockReturnValue("round1-feedback-prompt"),
  buildParentReviewCompletePrompt: vi
    .fn()
    .mockReturnValue("review-complete-prompt"),
  buildPersonaKickoffPrompt: vi.fn().mockReturnValue("kickoff-prompt"),
  buildReviewSubmittedPrompt: vi.fn().mockReturnValue("submitted-prompt"),
  buildReviewFeedbackAddedPrompt: vi
    .fn()
    .mockReturnValue("feedback-added-prompt"),
  buildReviewItemStatePrompt: vi.fn().mockReturnValue("item-state-prompt"),
  buildReviewThreadUpdatePrompt: vi
    .fn()
    .mockReturnValue("thread-update-prompt"),
  buildReviewerRecheckCancelledPrompt: vi
    .fn()
    .mockReturnValue("recheck-cancelled-prompt"),
  buildReviewerRecheckReadyPrompt: vi
    .fn()
    .mockReturnValue("recheck-ready-prompt"),
}));

vi.mock("../src/agents/reviews.js", () => ({
  createReview: vi.fn(),
  getReviewByReviewerAgent: vi.fn().mockResolvedValue(null),
  getReviewRecord: vi.fn().mockResolvedValue(null),
  addReviewFeedbackItem: vi.fn(),
  resolveReviewFeedbackItem: vi.fn(),
  reopenReviewFeedbackItem: vi.fn(),
  addThreadMessage: vi.fn(),
  listFeedbackItemsForAgent: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/agent-type-settings.js", () => ({
  CLI_AGENT_TYPES: ["claude", "codex", "opencode"],
  getEnabledAgentTypes: vi
    .fn()
    .mockResolvedValue(["claude", "codex", "opencode"]),
  isCliAgentType: vi.fn((t: string) =>
    ["claude", "codex", "opencode"].includes(t)
  ),
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    pool: {},
    agentManager: {
      getAgent: vi.fn().mockResolvedValue({
        id: "agt_parent",
        name: "parent",
        cwd: "/repo",
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        type: "codex",
        fullAccess: false,
        reviewAgentType: null,
        pins: [],
      }),
      listMedia: vi.fn().mockResolvedValue([]),
      getPersonaReview: vi.fn().mockResolvedValue(null),
      getReviewResolutions: vi.fn().mockResolvedValue([]),
      listResolvedFeedbackForRound: vi.fn().mockResolvedValue([]),
      completePersonaReview: vi.fn().mockResolvedValue({
        id: "rev_1",
        parentAgentId: "agt_parent",
        persona: "security",
        status: "complete",
        roundNumber: 1,
        lastReviewedCommit: "abc1234",
      }),
      countFeedbackForAgent: vi.fn().mockResolvedValue(0),
      submitReviewResolution: vi.fn().mockResolvedValue({
        review: { id: "rev_1", status: "awaiting_recheck" },
        resolution: { id: "res_1" },
      }),
      cancelReviewRecheck: vi.fn().mockResolvedValue({
        review: { id: "rev_1", parentAgentId: "agt_parent" },
        transitioned: true,
      }),
      updatePersonaReviewStatus: vi.fn().mockResolvedValue({
        parentAgentId: "agt_parent",
      }),
      createAgent: vi.fn().mockResolvedValue({
        id: "agt_child",
        name: "security-parent",
      }),
      createPersonaReview: vi.fn().mockResolvedValue(undefined),
      ...((overrides.agentManager as Record<string, unknown>) ?? {}),
    },
    publishUiEvent: vi.fn(),
    withStreamFlag: vi.fn(
      (agent: Record<string, unknown>) =>
        ({ ...agent, hasStream: false }) as never
    ),
    sendAgentPrompt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createReviewHandlers", () => {
  describe("getRecheckContext", () => {
    it("returns null when no review exists", async () => {
      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");
      expect(result).toBeNull();
    });

    it("returns availability=ready with compareRange when awaiting_recheck", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getPersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "awaiting_recheck",
            roundNumber: 1,
            lastReviewedCommit: "aaa1111",
          }),
          getReviewResolutions: vi.fn().mockResolvedValue([
            {
              roundNumber: 1,
              summary: "Fixed issues",
              resolutionCommit: "bbb2222",
              submittedAt: "2026-07-10T00:00:00Z",
            },
          ]),
          listResolvedFeedbackForRound: vi
            .fn()
            .mockResolvedValue([{ id: 1, resolution: "fixed" }]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");

      expect(result).toMatchObject({
        availability: "ready",
        reviewStatus: "awaiting_recheck",
        persona: "security",
        compareRange: "aaa1111...bbb2222",
        gitDiffCommand: "git diff aaa1111...bbb2222",
        resolutionSummary: "Fixed issues",
        resolutions: [{ id: 1, resolution: "fixed" }],
      });
    });

    it("returns availability=cancelled when review is cancelled", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getPersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "cancelled",
            roundNumber: 1,
            lastReviewedCommit: "aaa1111",
          }),
          getReviewResolutions: vi.fn().mockResolvedValue([]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");

      expect(result!.availability).toBe("cancelled");
    });

    it("returns availability=complete when round >= 2 and status is complete", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getPersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "complete",
            roundNumber: 2,
            lastReviewedCommit: "aaa1111",
          }),
          getReviewResolutions: vi.fn().mockResolvedValue([]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");

      expect(result!.availability).toBe("complete");
    });

    it("returns availability=waiting_for_resolution for round 1 in-progress review", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getPersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "in_progress",
            roundNumber: 1,
            lastReviewedCommit: "aaa1111",
          }),
          getReviewResolutions: vi.fn().mockResolvedValue([]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");

      expect(result!.availability).toBe("waiting_for_resolution");
    });

    it("returns null compareRange when commits are not valid SHAs", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getPersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "awaiting_recheck",
            roundNumber: 1,
            lastReviewedCommit: null,
          }),
          getReviewResolutions: vi.fn().mockResolvedValue([
            {
              roundNumber: 1,
              summary: "Fixed",
              resolutionCommit: "not-a-sha!",
              submittedAt: "2026-07-10T00:00:00Z",
            },
          ]),
          listResolvedFeedbackForRound: vi.fn().mockResolvedValue([]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getRecheckContext("agt_child");

      expect(result!.compareRange).toBeNull();
      expect(result!.gitDiffCommand).toBeNull();
    });
  });

  describe("completeReview", () => {
    it("sends round1 feedback prompt for mid-round-trip with non-clean result", async () => {
      const { buildParentRound1FeedbackPrompt } =
        await import("../src/reviews/injection-prompts.js");
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          completePersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "complete",
            roundNumber: 1,
            lastReviewedCommit: "abc1234",
          }),
          countFeedbackForAgent: vi.fn().mockResolvedValue(3),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.completeReview("agt_child", {
        verdict: "request_changes",
        summary: "Found issues",
      });

      expect(buildParentRound1FeedbackPrompt).toHaveBeenCalledWith({
        persona: "security",
        personaAgentId: "agt_child",
        verdict: "request_changes",
        feedbackCount: 3,
      });
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_parent",
        "round1-feedback-prompt"
      );
    });

    it("sends review-complete prompt for round >= 2", async () => {
      const { buildParentReviewCompletePrompt } =
        await import("../src/reviews/injection-prompts.js");
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          completePersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "complete",
            roundNumber: 2,
            lastReviewedCommit: "abc1234",
          }),
          countFeedbackForAgent: vi.fn().mockResolvedValue(1),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.completeReview("agt_child", {
        verdict: "approve",
        summary: "Looks good now",
      });

      expect(buildParentReviewCompletePrompt).toHaveBeenCalledWith({
        persona: "security",
        personaAgentId: "agt_child",
        verdict: "approve",
        summary: "Looks good now",
        feedbackCount: 1,
        roundNumber: 2,
      });
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_parent",
        "review-complete-prompt"
      );
    });

    it("sends review-complete prompt for clean approval in round 1", async () => {
      const { buildParentReviewCompletePrompt } =
        await import("../src/reviews/injection-prompts.js");
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          completePersonaReview: vi.fn().mockResolvedValue({
            id: "rev_1",
            parentAgentId: "agt_parent",
            persona: "security",
            status: "complete",
            roundNumber: 1,
            lastReviewedCommit: "abc1234",
          }),
          countFeedbackForAgent: vi.fn().mockResolvedValue(0),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.completeReview("agt_child", {
        verdict: "approve",
        summary: "All clear",
      });

      // Clean approval skips the round1 feedback prompt and uses review-complete
      expect(buildParentReviewCompletePrompt).toHaveBeenCalled();
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_parent",
        "review-complete-prompt"
      );
    });
  });

  describe("submitResolution", () => {
    it("sends recheck-ready prompt when review status is awaiting_recheck", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          submitReviewResolution: vi.fn().mockResolvedValue({
            review: { id: "rev_1", status: "awaiting_recheck" },
            resolution: { id: "res_1" },
          }),
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_parent",
            name: "parent",
            cwd: "/repo",
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.submitResolution("agt_parent", {
        personaAgentId: "agt_child",
        summary: "Fixed everything",
      });

      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_child",
        "recheck-ready-prompt"
      );
    });

    it("does not send prompt when status is not awaiting_recheck", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          submitReviewResolution: vi.fn().mockResolvedValue({
            review: { id: "rev_1", status: "complete" },
            resolution: { id: "res_1" },
          }),
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_parent",
            name: "parent",
            cwd: "/repo",
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.submitResolution("agt_parent", {
        personaAgentId: "agt_child",
        summary: "Fixed everything",
      });

      expect(deps.sendAgentPrompt).not.toHaveBeenCalled();
    });
  });

  describe("cancelRecheck", () => {
    it("sends cancelled prompt when transition occurred", async () => {
      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);

      await handlers.cancelRecheck("agt_parent", {
        personaAgentId: "agt_child",
        reason: "Wrong approach",
      });

      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_child",
        "recheck-cancelled-prompt"
      );
    });

    it("does not send prompt when no transition occurred", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          cancelReviewRecheck: vi.fn().mockResolvedValue({
            review: { id: "rev_1", parentAgentId: "agt_parent" },
            transitioned: false,
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.cancelRecheck("agt_parent", {
        personaAgentId: "agt_child",
      });

      expect(deps.sendAgentPrompt).not.toHaveBeenCalled();
    });
  });

  describe("updateReviewStatus", () => {
    it("publishes upsert events for both child and parent", async () => {
      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);

      await handlers.updateReviewStatus("agt_child", {
        status: "in_progress",
      });

      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
    });
  });

  describe("getParentContext", () => {
    it("returns pins and media for parent agent", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_parent",
            name: "parent",
            cwd: "/repo",
            pins: [{ label: "URL", value: "http://x", type: "url" }],
          }),
          listMedia: vi.fn().mockResolvedValue([
            {
              fileName: "shot.png",
              filePath: "/tmp/shot.png",
              description: "Screenshot",
              source: "dispatch_share",
              sizeBytes: 1024,
              createdAt: "2026-07-10T00:00:00Z",
            },
          ]),
        },
      });
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.getParentContext("agt_parent");

      expect(result.pins).toHaveLength(1);
      expect(result.pins[0]).toEqual({
        label: "URL",
        value: "http://x",
        type: "url",
      });
      expect(result.media).toHaveLength(1);
      expect(result.media[0].fileName).toBe("shot.png");
    });

    it("throws when parent not found", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn().mockResolvedValue(null),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await expect(handlers.getParentContext("agt_missing")).rejects.toThrow(
        "Parent agent not found."
      );
    });
  });

  describe("resolveReviewFeedback", () => {
    it("throws when item not found", async () => {
      const { resolveReviewFeedbackItem } =
        await import("../src/agents/reviews.js");
      vi.mocked(resolveReviewFeedbackItem).mockResolvedValue(null);

      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.resolveReviewFeedback("agt_child", 99, "fixed")
      ).rejects.toThrow("not found or not owned");
    });

    it("publishes UI events on success", async () => {
      const { resolveReviewFeedbackItem } =
        await import("../src/agents/reviews.js");
      vi.mocked(resolveReviewFeedbackItem).mockResolvedValue({
        item: { id: 1, status: "resolved", resolution: "fixed" },
        reviewId: 10,
        reviewStatus: "complete",
      } as never);

      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.resolveReviewFeedback(
        "agt_child",
        1,
        "fixed"
      );

      expect(result.item.resolution).toBe("fixed");
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review_feedback.updated",
          feedbackItemId: 1,
        })
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review.updated",
          reviewId: 10,
        })
      );
    });
  });

  describe("submitReview", () => {
    it("records and notifies the parent about a clean approval", async () => {
      const { createReview, getReviewByReviewerAgent } =
        await import("../src/agents/reviews.js");
      vi.mocked(getReviewByReviewerAgent).mockResolvedValueOnce(null);
      vi.mocked(createReview).mockResolvedValueOnce({
        id: 42,
        status: "resolved",
        summary: "No actionable issues found.",
        items: [],
      } as never);

      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn(async (id: string) =>
            id === "agt_reviewer"
              ? {
                  id,
                  name: "security-parent",
                  role: "review",
                  persona: "security",
                  parentAgentId: "agt_parent",
                }
              : {
                  id: "agt_parent",
                  name: "parent",
                  baseBranch: "main",
                }
          ),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      const result = await handlers.submitReview("agt_reviewer", {
        summary: "No actionable issues found.",
        feedback: [],
      });

      expect(result.review).toMatchObject({ id: 42, status: "resolved" });
      expect(createReview).toHaveBeenCalledWith(
        deps.pool,
        expect.objectContaining({
          agentId: "agt_parent",
          reviewerAgentId: "agt_reviewer",
          items: [],
        })
      );
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_parent",
        "submitted-prompt"
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "review.created",
        agentId: "agt_parent",
        reviewId: 42,
        reviewerAgentId: "agt_reviewer",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({
          id: "agt_reviewer",
          hasStream: false,
        }),
      });
    });

    it("prevents a reviewer from submitting twice", async () => {
      const { getReviewByReviewerAgent } =
        await import("../src/agents/reviews.js");
      vi.mocked(getReviewByReviewerAgent).mockResolvedValueOnce({
        id: 42,
      } as never);
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_reviewer",
            role: "review",
            persona: "security",
            parentAgentId: "agt_parent",
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.submitReview("agt_reviewer", {
          summary: "Again",
          feedback: [],
        })
      ).rejects.toThrow("already submitted");
    });

    it("maps a concurrent duplicate submission to the existing-review error", async () => {
      const { createReview, getReviewByReviewerAgent } =
        await import("../src/agents/reviews.js");
      vi.mocked(getReviewByReviewerAgent).mockResolvedValueOnce(null);
      vi.mocked(createReview).mockRejectedValueOnce({
        code: "23505",
        constraint: "idx_reviews_unique_agent_reviewer",
      });
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn(async (id: string) =>
            id === "agt_reviewer"
              ? {
                  id,
                  role: "review",
                  persona: "security",
                  parentAgentId: "agt_parent",
                }
              : {
                  id: "agt_parent",
                  name: "parent",
                  baseBranch: "main",
                }
          ),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.submitReview("agt_reviewer", {
          summary: "Concurrent submission",
          feedback: [],
        })
      ).rejects.toThrow("already submitted");
    });

    it("does not infer review authorization from a persona", async () => {
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_persona",
            role: "standard",
            persona: "security",
            parentAgentId: "agt_parent",
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.submitReview("agt_persona", {
          summary: "Not a review agent",
          feedback: [],
        })
      ).rejects.toThrow("only available to review agents");
    });
  });

  describe("addReviewThreadMessage", () => {
    it("throws when item not found", async () => {
      const { addThreadMessage } = await import("../src/agents/reviews.js");
      vi.mocked(addThreadMessage).mockResolvedValue(null);

      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.addReviewThreadMessage("agt_child", 99, "hello")
      ).rejects.toThrow("not found or not owned");
    });

    it("publishes UI event and returns message on success", async () => {
      const { addThreadMessage } = await import("../src/agents/reviews.js");
      vi.mocked(addThreadMessage).mockResolvedValue({
        message: {
          id: 5,
          feedbackItemId: 1,
          content: { body: "hello" },
        },
        reviewId: 10,
      } as never);

      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);
      const result = await handlers.addReviewThreadMessage(
        "agt_child",
        1,
        "hello"
      );

      expect(result.message.content).toEqual({ body: "hello" });
      expect(result.reviewId).toBe(10);
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review_feedback.updated",
          feedbackItemId: 1,
        })
      );
    });
  });
});
