import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/git/worktree.js", () => ({
  resolveHeadSha: vi.fn(async () => "abc123def456"),
}));

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async () => "/repo"),
  resolveWorktreeRoot: vi.fn(async () => "/repo"),
}));

vi.mock("../src/shared/git/base-ref.js", () => ({
  refreshRemoteBaseRef: vi.fn(async () => {}),
  resolveBaseRef: vi.fn(async () => "origin/main"),
}));

vi.mock("../src/shared/github/pr.js", () => ({
  getPrStatus: vi.fn(async () => ({ baseRefName: null })),
}));

vi.mock("../src/personas/loader.js", () => ({
  loadPersonas: vi.fn(async () => [
    { slug: "security", name: "Security", description: "Security review" },
  ]),
  loadPersonaBySlug: vi.fn(async () => ({
    slug: "security",
    name: "Security",
    prompt: "Review for security",
  })),
  assemblePersonaPrompt: vi.fn(() => "assembled-prompt"),
}));

vi.mock("../src/personas/review-diff.js", () => ({
  buildPersonaReviewDiff: vi.fn(async () => ({
    diff: "diff content",
    stats: {},
  })),
}));

vi.mock("../src/reviews/injection-prompts.js", () => ({
  buildPersonaKickoffPrompt: vi.fn(() => "kickoff-prompt"),
  buildReviewSubmittedPrompt: vi.fn(() => "submitted-prompt"),
  buildReviewFeedbackAddedPrompt: vi.fn(() => "feedback-added-prompt"),
  buildReviewItemStatePrompt: vi.fn(() => "item-state-prompt"),
  buildReviewThreadUpdatePrompt: vi.fn(() => "thread-update-prompt"),
}));

vi.mock("../src/agent-type-settings.js", () => ({
  CLI_AGENT_TYPES: ["claude", "codex", "cursor", "opencode"],
  getEnabledAgentTypes: vi.fn(async () => [
    "claude",
    "codex",
    "cursor",
    "opencode",
  ]),
  isCliAgentType: vi.fn((t: string) =>
    ["claude", "codex", "cursor", "opencode"].includes(t)
  ),
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

vi.mock("../src/agents/reviews.js", () => ({
  createReview: vi.fn(),
  getReviewByReviewerAgent: vi.fn(async () => null),
  getReviewRecord: vi.fn(async () => null),
  addReviewFeedbackItem: vi.fn(),
  reopenReviewFeedbackItem: vi.fn(),
  listFeedbackItemsForAgent: vi.fn(async () => []),
  resolveReviewFeedbackItem: vi.fn(async () => ({
    item: {
      id: 10,
      reviewId: 5,
      status: "resolved",
      resolution: "fixed",
      resolutionNote: null,
    },
    reviewId: 5,
    reviewStatus: "partially_resolved",
  })),
  addThreadMessage: vi.fn(async () => ({
    message: {
      id: 20,
      feedbackItemId: 10,
      authorType: "agent",
      authorAgentId: "agt_test1",
      type: "text",
      content: { body: "I fixed this" },
      createdAt: "2026-01-01T00:00:00Z",
    },
    reviewId: 5,
  })),
}));

vi.mock("../src/shared/media.js", () => ({
  isMediaFile: vi.fn(() => true),
  isTextFile: vi.fn(() => false),
  resolveMediaDir: vi.fn(() => "/tmp/media/agt_test1"),
}));

vi.mock("../src/pins.js", () => ({
  isPinType: vi.fn((t: string) =>
    ["url", "port", "code", "string", "pr", "filename", "markdown"].includes(t)
  ),
  validatePinValue: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("file-content")),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

import {
  createMcpHandlers,
  mcpMethodNotAllowed,
} from "../src/server/mcp-handlers.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";
import { isPinType, validatePinValue } from "../src/pins.js";
import {
  assemblePersonaPrompt,
  loadPersonaBySlug,
} from "../src/personas/loader.js";
import { getEnabledAgentTypes } from "../src/agent-type-settings.js";
import { isMediaFile, isTextFile } from "../src/shared/media.js";
import {
  resolveReviewFeedbackItem,
  addThreadMessage,
} from "../src/agents/reviews.js";

function createMockDeps() {
  return {
    pool: { query: vi.fn(async () => ({ rows: [] })) } as any,
    mediaRoot: "/tmp/media",
    agentManager: {
      getAgent: vi.fn(async () => ({
        id: "agt_test1",
        name: "test-agent",
        cwd: "/repo",
        status: "running",
        type: "claude",
        fullAccess: false,
        pins: [],
        latestEvent: null,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: null,
        mediaDir: null,
      })),
      upsertLatestEvent: vi.fn(async (_id: string, ev: any) => ({
        id: _id,
        name: "test-agent",
        latestEvent: ev,
      })),
      listAgents: vi.fn(async () => []),
      createAgent: vi.fn(async (opts: any) => ({
        id: "agt_new1",
        name: opts.name,
        type: opts.type,
        cwd: opts.cwd,
        status: "starting",
      })),
      renameAgent: vi.fn(async (id: string, name: string) => ({
        id,
        name,
      })),
      upsertPin: vi.fn(async (id: string) => ({
        id,
        name: "test-agent",
        pins: [{ label: "URL", value: "http://localhost", type: "url" }],
      })),
      deletePinById: vi.fn(async (id: string) => ({
        id,
        name: "test-agent",
        pins: [],
      })),
      listMedia: vi.fn(async () => []),
    },
    jobService: {
      completeRunForAgent: vi.fn(async () => ({
        id: "run_1",
        status: "completed",
      })),
      failRunForAgent: vi.fn(async () => ({
        id: "run_1",
        status: "failed",
      })),
      markNeedsInputForAgent: vi.fn(async () => ({
        id: "run_1",
        status: "needs_input",
      })),
      logForAgent: vi.fn(async () => ({
        id: "run_1",
        status: "running",
      })),
    },
    slackNotifier: {
      sendNotification: vi.fn(async () => ({ ok: true })),
    },
    publishUiEvent: vi.fn(),
    withStreamFlag: vi.fn((agent: any) => ({ ...agent, hasStream: false })),
    sendAgentPrompt: vi.fn(async () => {}),
    appLog: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any,
  };
}

describe("mcpMethodNotAllowed", () => {
  it("returns a JSON-RPC error with code -32000", () => {
    const result = mcpMethodNotAllowed();
    expect(result).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
});

describe("createMcpHandlers", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handlers: ReturnType<typeof createMcpHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handlers = createMcpHandlers(
      deps as unknown as Parameters<typeof createMcpHandlers>[0]
    );
  });

  describe("upsertEvent", () => {
    it("accepts valid event types", async () => {
      for (const type of [
        "working",
        "blocked",
        "waiting_user",
        "done",
        "idle",
      ]) {
        await handlers.upsertEvent("agt_test1", {
          type,
          message: "test message",
        });
      }
      expect(deps.agentManager.upsertLatestEvent).toHaveBeenCalledTimes(5);
    });

    it("rejects invalid event type", async () => {
      await expect(
        handlers.upsertEvent("agt_test1", {
          type: "invalid",
          message: "test",
        })
      ).rejects.toThrow("type must be one of:");
    });

    it("trims the event message", async () => {
      await handlers.upsertEvent("agt_test1", {
        type: "working",
        message: "  test  ",
      });
      expect(deps.agentManager.upsertLatestEvent).toHaveBeenCalledWith(
        "agt_test1",
        expect.objectContaining({ message: "test" })
      );
    });

    it("passes metadata through", async () => {
      const metadata = { key: "value" };
      await handlers.upsertEvent("agt_test1", {
        type: "done",
        message: "msg",
        metadata,
      });
      expect(deps.agentManager.upsertLatestEvent).toHaveBeenCalledWith(
        "agt_test1",
        expect.objectContaining({ metadata })
      );
    });

    it("publishes agent.upsert UI event with stream flag", async () => {
      await handlers.upsertEvent("agt_test1", {
        type: "working",
        message: "msg",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
      expect(deps.withStreamFlag).toHaveBeenCalled();
    });
  });

  describe("sendNotify", () => {
    it("sends notification for existing agent", async () => {
      const input = { message: "hello" };
      await handlers.sendNotify("agt_test1", input as any);
      expect(deps.agentManager.getAgent).toHaveBeenCalledWith("agt_test1");
      expect(deps.slackNotifier.sendNotification).toHaveBeenCalled();
    });

    it("throws when agent not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(
        handlers.sendNotify("agt_missing", {} as any)
      ).rejects.toThrow("Agent not found.");
    });
  });

  describe("upsertPin", () => {
    it("validates and creates a pin", async () => {
      await handlers.upsertPin("agt_test1", {
        label: "URL",
        value: "http://localhost",
        type: "url",
      });
      expect(deps.agentManager.upsertPin).toHaveBeenCalledWith("agt_test1", {
        label: "URL",
        value: "http://localhost",
        type: "url",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
    });

    it("rejects invalid pin type", async () => {
      vi.mocked(isPinType).mockReturnValue(false);
      await expect(
        handlers.upsertPin("agt_test1", {
          label: "Bad",
          value: "x",
          type: "invalid",
        })
      ).rejects.toThrow("Invalid pin type: invalid");
    });

    it("calls validatePinValue", async () => {
      vi.mocked(isPinType).mockReturnValue(true);
      await handlers.upsertPin("agt_test1", {
        label: "Port",
        value: "3000",
        type: "port",
      });
      expect(validatePinValue).toHaveBeenCalledWith("port", "3000");
    });
  });

  describe("deletePin", () => {
    it("deletes pin and publishes event", async () => {
      await handlers.deletePin("agt_test1", "pin_123");
      expect(deps.agentManager.deletePinById).toHaveBeenCalledWith(
        "agt_test1",
        "pin_123"
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
    });
  });

  describe("listPins", () => {
    it("returns the current agent pins", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        pins: [{ label: "URL", value: "http://localhost", type: "url" }],
      });

      await expect(handlers.listPins("agt_test1")).resolves.toEqual([
        { label: "URL", value: "http://localhost", type: "url" },
      ]);
    });
  });

  describe("deleteMedia", () => {
    it("removes the file, media record, seen records, and publishes an update", async () => {
      deps.pool.query.mockResolvedValueOnce({
        rows: [{ file_name: "shot.png" }],
      });
      await handlers.deleteMedia("agt_test1", "shot.png");

      const { unlink } = await import("node:fs/promises");
      expect(unlink).toHaveBeenCalledWith("/tmp/media/agt_test1/shot.png");
      expect(deps.pool.query).toHaveBeenNthCalledWith(
        2,
        "DELETE FROM media WHERE agent_id = $1 AND file_name = $2",
        ["agt_test1", "shot.png"]
      );
      expect(deps.pool.query).toHaveBeenNthCalledWith(
        3,
        "DELETE FROM media_seen WHERE agent_id = $1 AND media_key LIKE $2",
        ["agt_test1", "shot.png:%"]
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "media.changed",
        agentId: "agt_test1",
      });
    });
  });

  describe("getParentContext", () => {
    it("returns pins and media for parent agent", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_parent1",
        pins: [{ label: "PR", value: "#123", type: "pr" }],
      });
      deps.agentManager.listMedia.mockResolvedValue([
        {
          fileName: "shot.png",
          filePath: "/media/shot.png",
          description: "screenshot",
          source: "screenshot",
          sizeBytes: 1024,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const result = await handlers.getParentContext("agt_parent1");
      expect(result.pins).toEqual([{ label: "PR", value: "#123", type: "pr" }]);
      expect(result.media).toHaveLength(1);
      expect(result.media[0]).toHaveProperty("fileName", "shot.png");
    });

    it("throws when parent not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(handlers.getParentContext("agt_missing")).rejects.toThrow(
        "Parent agent not found."
      );
    });

    it("returns empty arrays for agent with no pins or media", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_parent1",
        pins: null,
      });
      deps.agentManager.listMedia.mockResolvedValue([]);
      const result = await handlers.getParentContext("agt_parent1");
      expect(result.pins).toEqual([]);
      expect(result.media).toEqual([]);
    });
  });

  describe("renameSession", () => {
    it("renames agent and publishes event", async () => {
      const result = await handlers.renameSession("agt_test1", "new-name");
      expect(result).toEqual({ id: "agt_test1", name: "new-name" });
      expect(deps.agentManager.renameAgent).toHaveBeenCalledWith(
        "agt_test1",
        "new-name"
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
    });
  });

  describe("jobComplete", () => {
    it("delegates to jobService.completeRunForAgent", async () => {
      const report = { status: "completed", summary: "done" };
      const result = await handlers.jobComplete("agt_test1", report);
      expect(result).toEqual({ runId: "run_1", status: "completed" });
      expect(deps.jobService.completeRunForAgent).toHaveBeenCalledWith(
        "agt_test1",
        report
      );
    });
  });

  describe("jobFailed", () => {
    it("delegates to jobService.failRunForAgent", async () => {
      const report = { status: "failed", summary: "error" };
      const result = await handlers.jobFailed("agt_test1", report);
      expect(result).toEqual({ runId: "run_1", status: "failed" });
      expect(deps.jobService.failRunForAgent).toHaveBeenCalledWith(
        "agt_test1",
        report
      );
    });
  });

  describe("jobNeedsInput", () => {
    it("delegates to jobService.markNeedsInputForAgent", async () => {
      const result = await handlers.jobNeedsInput("agt_test1", "need decision");
      expect(result).toEqual({ runId: "run_1", status: "needs_input" });
      expect(deps.jobService.markNeedsInputForAgent).toHaveBeenCalledWith(
        "agt_test1",
        "need decision"
      );
    });
  });

  describe("jobLog", () => {
    it("delegates to jobService.logForAgent", async () => {
      const input = {
        task: "build",
        message: "compiling",
        level: "info" as const,
      };
      const result = await handlers.jobLog("agt_test1", input);
      expect(result).toEqual({ runId: "run_1", status: "running" });
      expect(deps.jobService.logForAgent).toHaveBeenCalledWith(
        "agt_test1",
        input
      );
    });
  });

  describe("listPersonas", () => {
    it("returns personas mapped to slug/name/description", async () => {
      const result = await handlers.listPersonas("/repo");
      expect(result).toEqual([
        { slug: "security", name: "Security", description: "Security review" },
      ]);
    });
  });

  describe("launchPersona", () => {
    it("launches a persona agent without creating a review yet", async () => {
      const result = await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review this PR",
      });
      expect(result).toHaveProperty("agentId", "agt_new1");
      expect(result).toHaveProperty("persona", "security");
      expect(result).toHaveProperty("parentAgentId", "agt_test1");
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          persona: "security",
          parentAgentId: "agt_test1",
          type: "claude",
          role: "review",
        })
      );
    });

    it("passes the Cursor runtime to persona prompt assembly for Cursor review agents", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "cursor",
        fullAccess: false,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: "cursor",
        status: "running",
      });

      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review this PR",
      });

      expect(assemblePersonaPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "review this PR",
        expect.anything(),
        expect.objectContaining({ agentType: "cursor" })
      );
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cursor" })
      );
    });

    it("throws when parent not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(
        handlers.launchPersona("agt_missing", {
          persona: "security",
          context: "review",
        })
      ).rejects.toThrow("Parent agent not found.");
    });

    it("throws when persona not found", async () => {
      vi.mocked(loadPersonaBySlug).mockResolvedValue(null);
      await expect(
        handlers.launchPersona("agt_test1", {
          persona: "unknown",
          context: "review",
        })
      ).rejects.toThrow('Persona "unknown" not found');
    });

    it("throws when agent type is disabled", async () => {
      vi.mocked(getEnabledAgentTypes).mockResolvedValue([]);
      await expect(
        handlers.launchPersona("agt_test1", {
          persona: "security",
          context: "review",
        })
      ).rejects.toThrow("claude agents are disabled in settings.");
    });

    it("includes full-access arg for claude agents with fullAccess", async () => {
      vi.mocked(getEnabledAgentTypes).mockResolvedValue([
        "claude",
        "codex",
        "opencode",
      ]);
      vi.mocked(loadPersonaBySlug).mockResolvedValue({
        slug: "security",
        name: "Security",
        prompt: "Review for security",
      } as any);
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "claude",
        fullAccess: true,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: null,
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentArgs: expect.arrayContaining(["--dangerously-skip-permissions"]),
        })
      );
    });

    it("includes full-access arg for codex agents with fullAccess", async () => {
      vi.mocked(getEnabledAgentTypes).mockResolvedValue([
        "claude",
        "codex",
        "opencode",
      ]);
      vi.mocked(loadPersonaBySlug).mockResolvedValue({
        slug: "security",
        name: "Security",
        prompt: "Review for security",
      } as any);
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "codex",
        fullAccess: true,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: null,
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentArgs: expect.arrayContaining([
            "--dangerously-bypass-approvals-and-sandbox",
          ]),
        })
      );
    });

    it("does not include full-access arg for opencode agents", async () => {
      vi.mocked(getEnabledAgentTypes).mockResolvedValue([
        "claude",
        "codex",
        "opencode",
      ]);
      vi.mocked(loadPersonaBySlug).mockResolvedValue({
        slug: "security",
        name: "Security",
        prompt: "Review for security",
      } as any);
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "opencode",
        fullAccess: true,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: null,
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      const args = deps.agentManager.createAgent.mock.calls[0][0]
        .agentArgs as string[];
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("skips diff when includeDiff is false", async () => {
      const { buildPersonaReviewDiff } =
        await import("../src/personas/review-diff.js");
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
        includeDiff: false,
      });
      expect(buildPersonaReviewDiff).not.toHaveBeenCalled();
      expect(assemblePersonaPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "review",
        null,
        expect.objectContaining({ includeDiff: false })
      );
    });

    it("falls back to codex when parent type is not claude or opencode", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "gemini",
        fullAccess: false,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: null,
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "codex" })
      );
    });

    it("uses explicit agentType from opts over fallbacks", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "claude",
        fullAccess: false,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: "claude",
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
        agentType: "codex",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "codex" })
      );
    });

    it("uses parent reviewAgentType when no explicit agentType given", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "claude",
        fullAccess: false,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        reviewAgentType: "codex",
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "codex" })
      );
    });

    it("uses worktreePath as cwd when available", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test",
        cwd: "/repo",
        type: "claude",
        fullAccess: false,
        worktreePath: "/repo/.dispatch/worktrees/abc",
        worktreeBranch: "feature",
        baseBranch: null,
        reviewAgentType: null,
        status: "running",
      });
      await handlers.launchPersona("agt_test1", {
        persona: "security",
        context: "review",
      });
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo/.dispatch/worktrees/abc",
        })
      );
    });
  });

  describe("launchAgent", () => {
    it("includes the launching agent id in the child initial prompt", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "Investigate the flaky test.",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "worker",
          parentAgentId: "agt_test1",
          initialPrompt: expect.stringContaining(
            'You were launched by Dispatch agent "agt_test1"'
          ),
        })
      );
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: expect.stringContaining("Investigate the flaky test."),
        })
      );
    });

    it("throws when parent agent is not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(
        handlers.launchAgent("agt_missing", {
          name: "child",
          prompt: "hello",
        })
      ).rejects.toThrow("Parent agent not found.");
    });

    it("throws for unsupported agent type", async () => {
      await expect(
        handlers.launchAgent("agt_test1", {
          name: "child",
          prompt: "hello",
          type: "invalid-type",
        })
      ).rejects.toThrow("Unsupported agent type");
    });

    it("throws when agent type is disabled in settings", async () => {
      vi.mocked(getEnabledAgentTypes).mockResolvedValueOnce(["codex"] as any);
      await expect(
        handlers.launchAgent("agt_test1", {
          name: "child",
          prompt: "hello",
          type: "claude",
        })
      ).rejects.toThrow("claude agents are disabled in settings");
    });

    it("defaults agent type from parent when not specified", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "parent",
        cwd: "/repo",
        type: "codex",
        fullAccess: false,
        worktreePath: null,
      });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "codex" })
      );
    });

    it("uses parent worktreePath as cwd when available", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "parent",
        cwd: "/repo",
        type: "claude",
        fullAccess: false,
        worktreePath: "/worktrees/parent-branch",
      });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/worktrees/parent-branch" })
      );
    });

    it("falls back to parent cwd when worktreePath is null", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/repo" })
      );
    });

    it("uses explicit cwd when provided", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        cwd: "/other/dir",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/other/dir" })
      );
    });

    it("inherits fullAccess from parent when input omits it", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "parent",
        cwd: "/repo",
        type: "claude",
        fullAccess: true,
        worktreePath: null,
      });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fullAccess: true })
      );
    });

    it("overrides fullAccess to false when input explicitly sets false", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "parent",
        cwd: "/repo",
        type: "claude",
        fullAccess: true,
        worktreePath: null,
      });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        fullAccess: false,
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fullAccess: false })
      );
    });

    it("does not grant fullAccess when parent lacks it", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        fullAccess: true,
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fullAccess: false })
      );
    });

    it("passes worktree options through", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        useWorktree: true,
        createNewBranch: true,
        baseBranch: "develop",
        worktreeBranch: "feat/child-work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          useWorktree: true,
          createNewBranch: true,
          baseBranch: "develop",
          worktreeBranch: "feat/child-work",
        })
      );
    });

    it("passes templateId through", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        templateId: "tmpl_123",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "tmpl_123" })
      );
    });

    it("publishes UI event on success", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ name: "child" }),
      });
    });

    it("returns created agent id and name", async () => {
      const result = await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(result).toEqual({
        agentId: "agt_new1",
        name: "child",
      });
    });

    it("defaults useWorktree and createNewBranch to false", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          useWorktree: false,
          createNewBranch: false,
        })
      );
    });
  });

  describe("sendMessage", () => {
    it("delivers message to matching running agent", async () => {
      const target = {
        id: "agt_target1",
        name: "target-agent",
        cwd: "/repo",
        status: "running",
      };
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo", status: "running" },
        target,
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

      const result = await handlers.sendMessage("agt_test1", {
        target: "target-agent",
        message: "hello",
        senderRepoRoot: "/repo",
      });
      expect(result.delivered).toBe(true);
      expect(result.targetAgentId).toBe("agt_target1");
      expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
        "agt_target1",
        `--- DISPATCH MESSAGE ---\n${JSON.stringify({
          from: "test-agent",
          senderId: "agt_test1",
          message: "hello",
          replyTarget: "agt_test1",
        })}\n--- END MESSAGE ---\nOptional reply channel: If a response is necessary, use dispatch_send_message with the replyTarget above. Do not acknowledge routine status updates or completion messages unless a reply is explicitly requested.`,
        { swallowFailure: false }
      );
      expect(deps.sendAgentPrompt).not.toHaveBeenCalledWith(
        "agt_target1",
        expect.stringContaining(
          "Reply with dispatch_send_message using the replyTarget above."
        ),
        { swallowFailure: false }
      );
    });

    it("throws when sender not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "agt_other",
          message: "hello",
          senderRepoRoot: "/repo",
        })
      ).rejects.toThrow("Sender agent not found.");
    });

    it("returns no match when senderRepoRoot is null and no parent/child", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_test1",
          name: "sender",
          cwd: "/repo-a",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_other",
          name: "other",
          cwd: "/repo-b",
          status: "running",
          parentAgentId: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "agt_other",
          message: "hello",
          senderRepoRoot: null,
        })
      ).rejects.toThrow('No agent found matching "agt_other"');
    });

    it("throws when target agent is not running", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo", status: "running" },
        {
          id: "agt_target1",
          name: "target",
          cwd: "/repo",
          status: "stopped",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "agt_target1",
          message: "hi",
          senderRepoRoot: "/repo",
        })
      ).rejects.toThrow("is stopped, not running");
    });

    it("throws when multiple agents match by name", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo", status: "running" },
        { id: "agt_a", name: "worker-1", cwd: "/repo", status: "running" },
        { id: "agt_b", name: "worker-2", cwd: "/repo", status: "running" },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "worker",
          message: "hi",
          senderRepoRoot: "/repo",
        })
      ).rejects.toThrow("Multiple agents match");
    });

    it("throws when no agent matches", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo", status: "running" },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "nonexistent",
          message: "hi",
          senderRepoRoot: "/repo",
        })
      ).rejects.toThrow('No agent found matching "nonexistent"');
    });

    it("finds agent by ID when target starts with agt_", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo", status: "running" },
        {
          id: "agt_target1",
          name: "target",
          cwd: "/repo",
          status: "running",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");
      const result = await handlers.sendMessage("agt_test1", {
        target: "agt_target1",
        message: "hello",
        senderRepoRoot: "/repo",
      });
      expect(result.targetAgentId).toBe("agt_target1");
    });

    it("excludes agents from different repos", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        { id: "agt_test1", name: "sender", cwd: "/repo-a", status: "running" },
        {
          id: "agt_other",
          name: "other",
          cwd: "/repo-b",
          status: "running",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      await expect(
        handlers.sendMessage("agt_test1", {
          target: "other",
          message: "hi",
          senderRepoRoot: "/repo-a",
        })
      ).rejects.toThrow('No agent found matching "other"');
    });

    it("delivers to child agent in a different repo", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo-a",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      const result = await handlers.sendMessage("agt_parent", {
        target: "agt_child",
        message: "hi child",
        senderRepoRoot: "/repo-a",
      });
      expect(result.delivered).toBe(true);
      expect(result.targetAgentId).toBe("agt_child");
    });

    it("delivers to parent agent in a different repo", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo-a",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      const result = await handlers.sendMessage("agt_child", {
        target: "agt_parent",
        message: "hi parent",
        senderRepoRoot: "/repo-b",
      });
      expect(result.delivered).toBe(true);
      expect(result.targetAgentId).toBe("agt_parent");
    });

    it("delivers to child agent even when senderRepoRoot is null", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/not-a-repo",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      const result = await handlers.sendMessage("agt_parent", {
        target: "agt_child",
        message: "hi",
        senderRepoRoot: null,
      });
      expect(result.delivered).toBe(true);
      expect(result.targetAgentId).toBe("agt_child");
    });

    it("delivers cross-repo when the cross-repo messaging setting is enabled", async () => {
      // getSetting(cross_repo_messaging_enabled) -> "true"
      deps.pool.query.mockResolvedValue({ rows: [{ value: "true" }] });
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_test1",
          name: "sender",
          cwd: "/repo-a",
          status: "running",
        },
        { id: "agt_other", name: "other", cwd: "/repo-b", status: "running" },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      // senderRepoRoot null is tolerated once cross-repo messaging is on.
      const result = await handlers.sendMessage("agt_test1", {
        target: "other",
        message: "hi",
        senderRepoRoot: null,
      });
      expect(result.delivered).toBe(true);
      expect(result.targetAgentId).toBe("agt_other");
    });
  });

  describe("listAgentsForAgent", () => {
    it("returns agents in the same repo, excluding self", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "self",
          cwd: "/repo",
          status: "running",
          latestEvent: { type: "working", message: "busy" },
        },
        {
          id: "agt_peer",
          name: "peer",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
        },
        {
          id: "agt_other",
          name: "other",
          cwd: "/other-repo",
          status: "running",
          latestEvent: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_self", "/repo");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "agt_peer",
        name: "peer",
        status: "running",
        latestEvent: null,
      });
    });

    it("returns empty list when senderRepoRoot is null and no parent/child", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "self",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
        },
        {
          id: "agt_other",
          name: "other",
          cwd: "/other-repo",
          status: "running",
          latestEvent: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      const result = await handlers.listAgentsForAgent("agt_self", null);
      expect(result).toHaveLength(0);
    });

    it("includes direct child agent even in a different repo", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
        {
          id: "agt_unrelated",
          name: "unrelated",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_parent", "/repo-a");
      expect(result.map((a) => a.id)).toEqual(["agt_child"]);
    });

    it("includes direct parent agent even in a different repo", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_child", "/repo-b");
      expect(result.map((a) => a.id)).toEqual(["agt_parent"]);
    });

    it("does not include grandchild agents", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_grandparent",
          name: "grandparent",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_grandparent",
        },
        {
          id: "agt_grandchild",
          name: "grandchild",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent(
        "agt_grandparent",
        "/repo-a"
      );
      // Only direct child visible, not grandchild in different repo
      expect(result.map((a) => a.id)).toEqual(["agt_parent"]);
    });

    it("includes child agent even when senderRepoRoot is null", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/not-a-repo",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_parent", null);
      expect(result.map((a) => a.id)).toEqual(["agt_child"]);
    });

    it("lists agents across repos when the cross-repo messaging setting is enabled", async () => {
      // getSetting(cross_repo_messaging_enabled) -> "true"
      deps.pool.query.mockResolvedValue({ rows: [{ value: "true" }] });
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "self",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
        },
        {
          id: "agt_other",
          name: "other",
          cwd: "/other-repo",
          status: "running",
          latestEvent: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );
      // senderRepoRoot null is tolerated once cross-repo messaging is on.
      const result = await handlers.listAgentsForAgent("agt_self", null);
      expect(result.map((a) => a.id)).toEqual(["agt_other"]);
    });
  });

  describe("shareMedia", () => {
    it("rejects unsupported file types", async () => {
      vi.mocked(isMediaFile).mockReturnValue(false);
      await expect(
        handlers.shareMedia("agt_test1", {
          filePath: "/tmp/file.exe",
          description: "binary",
        })
      ).rejects.toThrow("Unsupported file type");
    });

    it("throws when agent not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(
        handlers.shareMedia("agt_missing", {
          filePath: "/tmp/shot.png",
          description: "screenshot",
        })
      ).rejects.toThrow("Agent not found.");
    });

    it("creates new media entry and publishes event", async () => {
      vi.mocked(isMediaFile).mockReturnValue(true);
      const result = await handlers.shareMedia("agt_test1", {
        filePath: "/tmp/shot.png",
        description: "a screenshot",
      });
      expect(result).toHaveProperty("fileName");
      expect(result).toHaveProperty("sizeBytes");
      expect(result.source).toBe("screenshot");
      expect(result.description).toBe("a screenshot");
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "media.changed", agentId: "agt_test1" })
      );
    });

    it("uses text source for text files", async () => {
      vi.mocked(isMediaFile).mockReturnValue(true);
      vi.mocked(isTextFile).mockReturnValue(true);
      const result = await handlers.shareMedia("agt_test1", {
        filePath: "/tmp/notes.md",
        description: "notes",
      });
      expect(result.source).toBe("text");
    });

    it("updates existing media when update option is provided", async () => {
      vi.mocked(isMediaFile).mockReturnValue(true);
      deps.pool.query.mockResolvedValueOnce({
        rows: [{ file_name: "existing.png" }],
      });
      const result = await handlers.shareMedia("agt_test1", {
        filePath: "/tmp/shot.png",
        description: "updated",
        update: "existing.png",
      });
      expect(result.fileName).toBe("existing.png");
      expect(deps.pool.query).toHaveBeenCalledTimes(2);
    });

    it("throws when update target not found", async () => {
      vi.mocked(isMediaFile).mockReturnValue(true);
      deps.pool.query.mockResolvedValueOnce({ rows: [] });
      await expect(
        handlers.shareMedia("agt_test1", {
          filePath: "/tmp/shot.png",
          description: "updated",
          update: "missing.png",
        })
      ).rejects.toThrow("No media file found");
    });
  });

  describe("resolveReviewFeedback", () => {
    it("resolves item and publishes both feedback and review events", async () => {
      const result = await handlers.resolveReviewFeedback(
        "agt_test1",
        10,
        "fixed",
        { note: "addressed in latest commit" }
      );
      expect(result.item.id).toBe(10);
      expect(result.reviewStatus).toBe("partially_resolved");
      expect(resolveReviewFeedbackItem).toHaveBeenCalledWith(
        deps.pool,
        10,
        "agt_test1",
        "fixed",
        {
          authorType: "agent",
          note: "addressed in latest commit",
          resolverRole: "assignee",
          resolvedBy: "agt_test1",
        }
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "review_feedback.updated",
        agentId: "agt_test1",
        feedbackItemId: 10,
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review.updated",
          agentId: "agt_test1",
          reviewId: 5,
          status: "partially_resolved",
        })
      );
    });

    it("throws when item not found", async () => {
      vi.mocked(resolveReviewFeedbackItem).mockResolvedValueOnce(null);
      await expect(
        handlers.resolveReviewFeedback("agt_test1", 99, "fixed")
      ).rejects.toThrow("Review feedback item #99 not found");
    });

    it("defaults note to null when omitted", async () => {
      await handlers.resolveReviewFeedback("agt_test1", 10, "ignored");
      expect(resolveReviewFeedbackItem).toHaveBeenCalledWith(
        deps.pool,
        10,
        "agt_test1",
        "ignored",
        {
          authorType: "agent",
          note: null,
          resolverRole: "assignee",
          resolvedBy: "agt_test1",
        }
      );
    });
  });

  describe("addReviewThreadMessage", () => {
    it("adds message and publishes feedback event", async () => {
      const result = await handlers.addReviewThreadMessage(
        "agt_test1",
        10,
        "I fixed this"
      );
      expect(result.message.id).toBe(20);
      expect(result.reviewId).toBe(5);
      expect(addThreadMessage).toHaveBeenCalledWith(
        deps.pool,
        10,
        "agt_test1",
        "agent",
        "I fixed this",
        "agt_test1"
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "review_feedback.updated",
        agentId: "agt_test1",
        feedbackItemId: 10,
      });
    });

    it("throws when item not found", async () => {
      vi.mocked(addThreadMessage).mockResolvedValueOnce(null);
      await expect(
        handlers.addReviewThreadMessage("agt_test1", 99, "hello")
      ).rejects.toThrow("Review feedback item #99 not found");
    });
  });

  describe("listMedia", () => {
    it("returns media for agent", async () => {
      deps.pool.query.mockResolvedValue({
        rows: [
          {
            file_name: "shot.png",
            source: "screenshot",
            description: "a shot",
            size_bytes: 1024,
            created_at: new Date("2026-01-01"),
          },
        ],
      });
      const result = await handlers.listMedia("agt_test1", {});
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe("shot.png");
      expect(result[0].sizeBytes).toBe(1024);
    });

    it("throws when agent not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);
      await expect(handlers.listMedia("agt_missing", {})).rejects.toThrow(
        "Agent not found."
      );
    });

    it("filters by source when provided", async () => {
      deps.pool.query.mockResolvedValue({ rows: [] });
      await handlers.listMedia("agt_test1", { source: "screenshot" });
      expect(deps.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("source = $2"),
        ["agt_test1", "screenshot"]
      );
    });

    it("omits source filter when not provided", async () => {
      deps.pool.query.mockResolvedValue({ rows: [] });
      await handlers.listMedia("agt_test1", {});
      expect(deps.pool.query).toHaveBeenCalledWith(
        expect.not.stringContaining("source = $2"),
        ["agt_test1"]
      );
    });
  });
});
