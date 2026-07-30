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
  buildPersonaKickoffPrompt: vi.fn().mockReturnValue("kickoff-prompt"),
  buildReviewSubmittedPrompt: vi.fn().mockReturnValue("submitted-prompt"),
  buildReviewFeedbackAddedPrompt: vi
    .fn()
    .mockReturnValue("feedback-added-prompt"),
  buildReviewItemStatePrompt: vi.fn().mockReturnValue("item-state-prompt"),
  buildReviewThreadUpdatePrompt: vi
    .fn()
    .mockReturnValue("thread-update-prompt"),
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
      createAgent: vi.fn().mockResolvedValue({
        id: "agt_child",
        name: "security-parent",
      }),
      ...((overrides.agentManager as Record<string, unknown>) ?? {}),
    },
    publishUiEvent: vi.fn(),
    withStreamFlag: vi.fn(
      (agent: Record<string, unknown>) =>
        ({ ...agent, hasStream: false }) as never
    ),
    sendAgentPrompt: vi.fn().mockResolvedValue(undefined),
    appLog: { warn: vi.fn() },
    ...overrides,
  };
}

describe("createReviewHandlers", () => {
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

    it("notifies the parent when the reviewer verifies and resolves a fix", async () => {
      const { getReviewRecord, resolveReviewFeedbackItem } =
        await import("../src/agents/reviews.js");
      vi.mocked(resolveReviewFeedbackItem).mockResolvedValueOnce({
        item: { id: 1, status: "resolved", resolution: "fixed" },
        reviewId: 10,
        reviewStatus: "resolved",
      } as never);
      vi.mocked(getReviewRecord).mockResolvedValueOnce({
        id: 10,
        agentId: "agt_parent",
        assignedAgentId: "agt_parent",
        reviewerAgentId: "agt_reviewer",
      } as never);

      const deps = makeDeps();
      const handlers = createReviewHandlers(deps as never);
      await handlers.resolveReviewFeedback("agt_reviewer", 1, "fixed");

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "review_feedback.updated",
        agentId: "agt_parent",
        feedbackItemId: 1,
      });
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_parent",
        "item-state-prompt"
      );
    });

    it("authorizes review-role callers only as the reviewer", async () => {
      const { resolveReviewFeedbackItem } =
        await import("../src/agents/reviews.js");
      vi.mocked(resolveReviewFeedbackItem).mockResolvedValueOnce({
        item: { id: 1, status: "resolved", resolution: "fixed" },
        reviewId: 10,
        reviewStatus: "resolved",
      } as never);
      const deps = makeDeps({
        agentManager: {
          ...makeDeps().agentManager,
          getAgent: vi.fn().mockResolvedValue({
            id: "agt_reviewer",
            role: "review",
            name: "reviewer",
            cwd: "/repo",
          }),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.resolveReviewFeedback("agt_reviewer", 1, "fixed");

      expect(resolveReviewFeedbackItem).toHaveBeenCalledWith(
        deps.pool,
        1,
        "agt_reviewer",
        "fixed",
        expect.objectContaining({ resolverRole: "reviewer" })
      );
    });
  });

  describe("submitReview", () => {
    it("logs prompt injection failures without rolling back the saved review", async () => {
      const { createReview, getReviewByReviewerAgent } =
        await import("../src/agents/reviews.js");
      vi.mocked(getReviewByReviewerAgent).mockResolvedValueOnce(null);
      vi.mocked(createReview).mockResolvedValueOnce({
        id: 40,
        status: "resolved",
        summary: "Looks good.",
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
              : { id: "agt_parent", name: "parent", baseBranch: "main" }
          ),
        },
        sendAgentPrompt: vi.fn().mockRejectedValue(new Error("not running")),
      });
      const handlers = createReviewHandlers(deps as never);

      await expect(
        handlers.submitReview("agt_reviewer", {
          summary: "Looks good.",
          feedback: [],
        })
      ).resolves.toMatchObject({ review: { id: 40 } });
      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          agentId: "agt_parent",
        }),
        "Review prompt injection failed after the review mutation was saved"
      );
    });

    it("allows feedback items without a review summary", async () => {
      const { createReview, getReviewByReviewerAgent } =
        await import("../src/agents/reviews.js");
      vi.mocked(getReviewByReviewerAgent).mockResolvedValueOnce(null);
      vi.mocked(createReview).mockResolvedValueOnce({
        id: 41,
        status: "open",
        summary: null,
        items: [
          {
            id: 7,
            filePath: null,
            lineStart: null,
            messages: [{ content: { body: "Actionable issue" } }],
          },
        ],
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
              : { id: "agt_parent", name: "parent", baseBranch: "main" }
          ),
        },
      });
      const handlers = createReviewHandlers(deps as never);

      await handlers.submitReview("agt_reviewer", {
        feedback: [{ comment: "Actionable issue" }],
      });

      expect(createReview).toHaveBeenCalledWith(
        deps.pool,
        expect.objectContaining({ summary: null })
      );
    });

    it("rejects a clean approval without a nonblank summary", async () => {
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
          summary: "   ",
          feedback: [],
        })
      ).rejects.toThrow("summary is required for a clean approval");
    });

    it("rejects summaries longer than 280 characters", async () => {
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
          summary: "x".repeat(281),
          feedback: [{ comment: "Actionable issue" }],
        })
      ).rejects.toThrow("Review summary must be 280 characters or fewer.");
    });

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
