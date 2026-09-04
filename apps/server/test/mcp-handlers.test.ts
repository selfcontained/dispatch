import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildStartupTurn } from "../src/agents/tmux/command-builder.js";

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
    [
      "url",
      "port",
      "code",
      "string",
      "pr",
      "filename",
      "markdown",
      "shortcut",
    ].includes(t)
  ),
  validatePinValue: vi.fn(),
  validatePinCaption: vi.fn(),
  validatePinShortcutFields: vi.fn(),
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
import { GENERIC_REVIEW_PERSONA_SLUG } from "../src/personas/built-in.js";
import { getEnabledAgentTypes } from "../src/agent-type-settings.js";
import {
  isMediaFile,
  isTextFile,
  resolveMediaDir,
} from "../src/shared/media.js";
import {
  resolveReviewFeedbackItem,
  addThreadMessage,
} from "../src/agents/reviews.js";

function templateRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "tmpl_123",
    name: "Build Idea",
    directory: "/repo",
    description: null,
    prompt: "do the thing",
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowMedia: false,
    selfImprove: false,
    ...overrides,
  };
}

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
      beginArchive: vi.fn(async (id: string) => ({
        id,
        status: "archiving",
      })),
      executeArchive: vi.fn(
        async (
          id: string,
          callbacks: {
            onComplete: (deletedIds: string[]) => void;
          }
        ) => {
          callbacks.onComplete([id]);
        }
      ),
      // Mirrors the manager contract: the record, plus the pin as stored and
      // whether it was created, so the tool can echo it back.
      upsertPin: vi.fn(async (id: string, pin: Record<string, unknown>) => ({
        agent: {
          id,
          name: "test-agent",
          pins: [{ id: "pin_url", ...pin }],
        },
        pin: { id: "pin_url", ...pin },
        created: true,
      })),
      upsertPins: vi.fn(
        async (id: string, specs: Array<Record<string, unknown>>) => ({
          agent: {
            id,
            name: "test-agent",
            pins: specs.map((pin, index) => ({ id: `pin_${index}`, ...pin })),
          },
          pins: specs.map((pin, index) => ({ id: `pin_${index}`, ...pin })),
        })
      ),
      deletePinById: vi.fn(async (id: string) => ({
        id,
        name: "test-agent",
        pins: [],
      })),
      deletePinsByIds: vi.fn(async (id: string) => ({
        id,
        name: "test-agent",
        pins: [],
      })),
      deletePinsByGroup: vi.fn(async (id: string) => ({
        id,
        name: "test-agent",
        pins: [],
      })),
      listMedia: vi.fn(async () => []),
    },
    jobService: {
      getActiveRunForAgent: vi.fn(async () => null),
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
    templateService: {
      getTemplate: vi.fn(async (_id: string): Promise<any> => null),
    },
    slackNotifier: {
      sendNotification: vi.fn(async () => ({ ok: true })),
    },
    publishUiEvent: vi.fn(),
    withStreamFlag: vi.fn((agent: any) => ({ ...agent, hasStream: false })),
    sendAgentPrompt: vi.fn(async () => {}),
    enqueueAgentPrompt: vi.fn(async () => ({
      held: false,
      delivery: Promise.resolve(),
    })),
    appLog: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any,
    beginBackgroundArchive: vi.fn(async (id: string) => ({
      id,
      name: id === "agt_test1" ? "test-agent" : "child",
      status: "archiving",
    })),
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

    // Regression: group and icon were accepted by the tool schema but never
    // forwarded, so agents silently lost them.
    it("forwards every shortcut decoration to the manager", async () => {
      vi.mocked(isPinType).mockReturnValue(true);
      await handlers.upsertPin("agt_test1", {
        label: "Work on X",
        value: "work on x",
        type: "shortcut",
        caption: "**High priority**",
        group: "Ready to build",
        icon: "rocket",
        variant: "primary",
        confirm: true,
      });
      expect(deps.agentManager.upsertPin).toHaveBeenCalledWith("agt_test1", {
        label: "Work on X",
        value: "work on x",
        type: "shortcut",
        caption: "**High priority**",
        group: "Ready to build",
        icon: "rocket",
        variant: "primary",
        confirm: true,
      });
    });

    it("drops shortcut-only decorations on other pin types", async () => {
      vi.mocked(isPinType).mockReturnValue(true);
      await handlers.upsertPin("agt_test1", {
        label: "Dev Server",
        value: "http://localhost",
        type: "url",
        caption: "Vite",
        group: "Dev stack",
        icon: "rocket",
        variant: "primary",
        confirm: true,
      });
      expect(deps.agentManager.upsertPin).toHaveBeenCalledWith("agt_test1", {
        label: "Dev Server",
        value: "http://localhost",
        type: "url",
        caption: "Vite",
        group: "Dev stack",
      });
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
      await handlers.deletePin("agt_test1", { id: "pin_123" });
      expect(deps.agentManager.deletePinsByIds).toHaveBeenCalledWith(
        "agt_test1",
        ["pin_123"]
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.upsert" })
      );
    });

    it("deletes several pins in one call", async () => {
      await handlers.deletePin("agt_test1", { ids: ["pin_1", "pin_2"] });
      expect(deps.agentManager.deletePinsByIds).toHaveBeenCalledWith(
        "agt_test1",
        ["pin_1", "pin_2"]
      );
    });

    it("clears a group", async () => {
      await handlers.deletePin("agt_test1", { group: "Ready to build" });
      expect(deps.agentManager.deletePinsByGroup).toHaveBeenCalledWith(
        "agt_test1",
        "Ready to build"
      );
    });

    it("rejects an ambiguous target", async () => {
      // Accepting both would leave it unclear which one actually applied.
      await expect(
        handlers.deletePin("agt_test1", { id: "pin_1", group: "Group" })
      ).rejects.toThrow(/exactly one/i);
      await expect(handlers.deletePin("agt_test1", {})).rejects.toThrow(
        /exactly one/i
      );
    });
  });

  describe("upsertPins", () => {
    it("writes a batch through one manager call", async () => {
      await handlers.upsertPins("agt_test1", {
        pins: [
          { label: "One", value: "1", type: "string" },
          { label: "Two", value: "2", type: "string" },
        ],
      });
      expect(deps.agentManager.upsertPins).toHaveBeenCalledWith(
        "agt_test1",
        [
          { label: "One", value: "1", type: "string" },
          { label: "Two", value: "2", type: "string" },
        ],
        {}
      );
      // One event for the whole batch, not one per pin.
      expect(deps.publishUiEvent).toHaveBeenCalledTimes(1);
    });

    it("validates every entry before writing any", async () => {
      vi.mocked(validatePinValue).mockImplementation((type, value) => {
        if (value === "bad") throw new Error("Invalid pin value");
      });
      await expect(
        handlers.upsertPins("agt_test1", {
          pins: [
            { label: "One", value: "1", type: "string" },
            { label: "Two", value: "bad", type: "string" },
          ],
        })
      ).rejects.toThrow(/Invalid pin value/);
      expect(deps.agentManager.upsertPins).not.toHaveBeenCalled();
    });

    it("passes the scoping group through as an option, not per entry", async () => {
      // Filing entries under the group is `replacePinGroup`'s own job — the
      // handler compensating for it here is what let the primitive drift from
      // its own contract. Covered end-to-end in pin-write.test.ts.
      await handlers.upsertPins("agt_test1", {
        mode: "replace",
        group: "Ready to build",
        pins: [
          { label: "One", value: "1", type: "string", group: "Elsewhere" },
        ],
      });
      expect(deps.agentManager.upsertPins).toHaveBeenCalledWith(
        "agt_test1",
        [{ label: "One", value: "1", type: "string", group: "Elsewhere" }],
        { mode: "replace", group: "Ready to build" }
      );
    });
  });

  // Agent rows as the family-read query returns them. `deleted_at` is not
  // selected on purpose: an archived owner is still readable.
  const FAMILY_ROWS: Record<
    string,
    {
      id: string;
      name: string;
      media_dir: string | null;
      pins: unknown[];
      parent_agent_id: string | null;
    }
  > = {
    agt_test1: {
      id: "agt_test1",
      name: "parent",
      media_dir: null,
      pins: [
        { id: "pin_url", label: "URL", value: "http://localhost", type: "url" },
      ],
      parent_agent_id: null,
    },
    agt_child: {
      id: "agt_child",
      name: "child",
      media_dir: "/custom/child-media",
      pins: [
        {
          id: "pin_pr",
          label: "PR",
          value: "https://example/pr/1",
          type: "pr",
        },
      ],
      parent_agent_id: "agt_test1",
    },
    agt_grandchild: {
      id: "agt_grandchild",
      name: "grandchild",
      media_dir: null,
      pins: [],
      parent_agent_id: "agt_child",
    },
    agt_stranger: {
      id: "agt_stranger",
      name: "stranger",
      media_dir: null,
      pins: [{ id: "pin_x", label: "X", value: "y", type: "string" }],
      parent_agent_id: null,
    },
  };

  function mockFamilyRows(): void {
    deps.pool.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM agents WHERE id = ANY")) {
          const ids = (params?.[0] as string[]) ?? [];
          return { rows: ids.map((id) => FAMILY_ROWS[id]).filter(Boolean) };
        }
        if (sql.includes("FROM media")) {
          return {
            rows: [
              {
                file_name: "shot.png",
                source: "screenshot",
                description: "the shot",
                size_bytes: 10,
                created_at: new Date("2026-01-01T00:00:00Z"),
              },
            ],
          };
        }
        return { rows: [] };
      }
    );
  }

  describe("listPins", () => {
    it("returns the current agent pins", async () => {
      mockFamilyRows();

      await expect(handlers.listPins("agt_test1")).resolves.toEqual([
        {
          id: "pin_url",
          label: "URL",
          value: "http://localhost",
          type: "url",
        },
      ]);
    });

    it("reads a direct child's pins", async () => {
      mockFamilyRows();
      await expect(
        handlers.listPins("agt_test1", { ownerAgentId: "agt_child" })
      ).resolves.toEqual([
        {
          id: "pin_pr",
          label: "PR",
          value: "https://example/pr/1",
          type: "pr",
        },
      ]);
    });

    it("reads the parent's pins from a child", async () => {
      mockFamilyRows();
      await expect(
        handlers.listPins("agt_child", { ownerAgentId: "agt_test1" })
      ).resolves.toEqual([
        { id: "pin_url", label: "URL", value: "http://localhost", type: "url" },
      ]);
    });

    it.each([
      ["a grandchild", "agt_test1", "agt_grandchild"],
      ["a grandparent", "agt_grandchild", "agt_test1"],
      ["an unrelated agent", "agt_test1", "agt_stranger"],
      ["an unknown id", "agt_test1", "agt_missing"],
    ])("reports %s as not found", async (_label, requester, owner) => {
      mockFamilyRows();
      await expect(
        handlers.listPins(requester, { ownerAgentId: owner })
      ).rejects.toThrow("Agent not found.");
    });
  });

  describe("listMedia", () => {
    it("lists a child's media from the child's own directory", async () => {
      mockFamilyRows();
      const items = await handlers.listMedia("agt_test1", {
        ownerAgentId: "agt_child",
      });
      expect(items).toEqual([
        {
          ownerAgentId: "agt_child",
          fileName: "shot.png",
          // resolveMediaDir is mocked to a fixed path in this file; the call
          // below is what proves the child's own directory was requested.
          filePath: "/tmp/media/agt_test1/shot.png",
          source: "screenshot",
          description: "the shot",
          sizeBytes: 10,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(resolveMediaDir).toHaveBeenLastCalledWith(
        "agt_child",
        "/custom/child-media",
        "/tmp/media"
      );
      const mediaCall = deps.pool.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM media")
      );
      expect(mediaCall?.[1]).toEqual(["agt_child"]);
    });

    it("defaults to the caller's own media directory", async () => {
      mockFamilyRows();
      const items = await handlers.listMedia("agt_test1", {});
      expect(items[0]).toMatchObject({
        ownerAgentId: "agt_test1",
        filePath: "/tmp/media/agt_test1/shot.png",
      });
      expect(resolveMediaDir).toHaveBeenLastCalledWith(
        "agt_test1",
        null,
        "/tmp/media"
      );
    });

    it("refuses an unrelated owner", async () => {
      mockFamilyRows();
      await expect(
        handlers.listMedia("agt_test1", { ownerAgentId: "agt_stranger" })
      ).rejects.toThrow("Agent not found.");
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
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "media.changed",
        agentId: "agt_test1",
      });
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
          // The launch post is attributed from the trusted launcher, never
          // from parentAgentId.
          launchedByAgentId: "agt_test1",
          type: "claude",
          role: "review",
        })
      );
    });

    it("refuses a persona review launched from a child agent", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child",
        name: "child-agent",
        cwd: "/repo",
        type: "claude",
        fullAccess: false,
        status: "running",
        parentAgentId: "agt_root",
      } as any);

      await expect(
        handlers.launchPersona("agt_child", {
          persona: "security",
          context: "review this PR",
        })
      ).rejects.toThrow("cannot launch persona reviews");
      expect(deps.agentManager.createAgent).not.toHaveBeenCalled();
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

    it("falls back to the built-in reviewer when no repo file defines it", async () => {
      vi.mocked(loadPersonaBySlug).mockResolvedValue(null);

      await handlers.launchPersona("agt_test1", {
        persona: GENERIC_REVIEW_PERSONA_SLUG,
        context: "review",
      });

      expect(assemblePersonaPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: GENERIC_REVIEW_PERSONA_SLUG,
          name: "General Code Review",
        }),
        "review",
        expect.anything(),
        expect.anything()
      );
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ persona: GENERIC_REVIEW_PERSONA_SLUG })
      );
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
    it("refuses to launch a child under a parent that is being archived", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test-agent",
        cwd: "/repo",
        status: "archiving",
        type: "claude",
      } as any);

      await expect(
        handlers.launchAgent("agt_test1", { name: "orphan", prompt: "work" })
      ).rejects.toThrow("being archived");
      expect(deps.agentManager.createAgent).not.toHaveBeenCalled();
    });

    it("records the launcher and refuses a further child from a child agent", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child",
        name: "child-agent",
        cwd: "/repo",
        status: "running",
        type: "claude",
        parentAgentId: "agt_root",
      } as any);

      await expect(
        handlers.launchAgent("agt_child", { name: "grandchild", prompt: "go" })
      ).rejects.toThrow("cannot launch further children");
      expect(deps.agentManager.createAgent).not.toHaveBeenCalled();
    });

    it("lets a child agent launch an independent agent", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child",
        name: "child-agent",
        cwd: "/repo",
        status: "running",
        type: "claude",
        fullAccess: false,
        parentAgentId: "agt_root",
      } as any);

      await handlers.launchAgent("agt_child", {
        name: "peer",
        prompt: "go",
        child: false,
      });

      const created = deps.agentManager.createAgent.mock.calls[0][0];
      expect(created.parentAgentId).toBeUndefined();
      expect(created.launchedByAgentId).toBe("agt_child");
      expect(created.initialPrompt).toContain("as an independent agent");
      expect(created.initialPrompt).not.toContain("You are a child agent");
    });

    it("keeps the launcher recorded on a child launch", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          parentAgentId: "agt_test1",
          launchedByAgentId: "agt_test1",
        })
      );
    });

    it("attributes the launch post to the launching agent with its own prompt", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "Review the diff",
        child: false,
      });

      const created = deps.agentManager.createAgent.mock.calls[0]?.[0];
      // Attribution comes from the authenticated launcher, not parentAgentId
      // (absent on a child: false launch); the feed shows the unwrapped prompt.
      expect(created).toMatchObject({
        launchedByAgentId: "agt_test1",
        launchContext: { prompt: "Review the diff" },
      });
      expect(created.parentAgentId).toBeUndefined();
    });

    it("tells a child agent up front that it cannot launch children", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "work",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: expect.stringContaining("You are a child agent"),
        })
      );
    });

    it("wraps the child's whole prompt, launch header included, in the Chat envelope", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "Investigate the flaky test.",
      });

      // The child's first turn is built from what createAgent was handed:
      // with the chat surface on it is wrapped whole, so the launch header
      // the CLI needs stays inside the envelope, while the feed post keeps
      // the prompt as the launcher wrote it.
      const created = deps.agentManager.createAgent.mock.calls[0][0];
      const turn = buildStartupTurn(
        {
          initialPrompt: created.initialPrompt,
          chatLaunchPost: { messageId: "post-1", attachmentLines: [] },
        },
        { chatSurface: true }
      );
      expect(turn).toBe(
        [
          "--- DISPATCH CHAT (id: post-1) ---",
          created.initialPrompt,
          "--- END DISPATCH CHAT ---",
          'The user only sees Chat — reply with dispatch_chat_post (replyTo: "post-1").',
        ].join("\n")
      );
      expect(turn).toContain('You were launched by Dispatch agent "agt_test1"');
      expect(turn).toContain("Investigate the flaky test.");
      expect(created.launchContext).toEqual({
        prompt: "Investigate the flaky test.",
      });
    });

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

    it("passes a configured model ID through after trimming it", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "worker",
        prompt: "Use my account model.",
        type: "claude",
        model: " fable ",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: "fable" })
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
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ id: "tmpl_123" })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        templateId: "tmpl_123",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "tmpl_123" })
      );
    });

    it("renders the template's prompt instead of only the caller's prompt", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({
          prompt: "Build this idea:\n\n{{D:Idea|required|textarea}}",
        })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "fix the launch bug",
        templateId: "tmpl_123",
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain("Build this idea:");
      expect(initialPrompt).toContain("fix the launch bug");
      expect(initialPrompt).not.toContain("{{D:");
      expect(
        deps.agentManager.createAgent.mock.calls[0][0].launchContext
      ).toEqual({ prompt: "fix the launch bug" });
    });

    it("appends the caller's prompt to the template's prompt", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ prompt: "Run the nightly checks." })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "skip the slow suite",
        templateId: "tmpl_123",
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain(
        "Run the nightly checks.\n\nskip the slow suite"
      );
    });

    it("fills template args from templateArgs", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({
          prompt: "Review {{D:Target}} for {{D:Concern|required}}.",
        })
      );

      const result = await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "be thorough",
        templateId: "tmpl_123",
        templateArgs: { Target: "the diff", Concern: "security" },
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain("Review the diff for security.");
      expect(result.note).toBeUndefined();
    });

    it("launches and reports back when args are left unset", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({
          prompt: "Review {{D:Target|required}} for {{D:Concern|required}}.",
        })
      );

      const result = await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "have a look",
        templateId: "tmpl_123",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalled();
      expect(result.note).toContain("Target, Concern");
    });

    it("reports templateArgs keys that matched no arg", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ prompt: "Review {{D:PR URL|required}}." })
      );

      const result = await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "review it please",
        templateId: "tmpl_123",
        templateArgs: { prUrl: "https://example.com/pr/1" },
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain("review it please");
      expect(result.note).toContain("Unrecognized templateArgs");
      expect(result.note).toContain("prUrl");
      expect(result.note).toContain("PR URL");
    });

    it("appends self-improvement guidance when the template opts in", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ prompt: "Do the thing.", selfImprove: true })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "now",
        templateId: "tmpl_123",
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain("Self-improvement:");
      expect(initialPrompt).toContain('templateId "tmpl_123"');
    });

    it("uses the caller's prompt alone when the template has no prompt", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ prompt: null })
      );

      const result = await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "just do it",
        templateId: "tmpl_123",
      });

      const { initialPrompt } = deps.agentManager.createAgent.mock.calls[0][0];
      expect(initialPrompt).toContain("just do it");
      expect(result.note).toBeUndefined();
    });

    it("takes worktree config from the template when the caller omits it", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({
          useWorktree: true,
          baseBranch: "develop",
          branchName: "feat/from-template",
        })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        templateId: "tmpl_123",
      });

      expect(deps.templateService.getTemplate).toHaveBeenCalledWith("tmpl_123");
      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          useWorktree: true,
          createNewBranch: true,
          baseBranch: "develop",
          worktreeBranch: "feat/from-template",
        })
      );
    });

    it("lets explicit worktree args override the template", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({
          useWorktree: true,
          baseBranch: "develop",
          branchName: "feat/from-template",
        })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        templateId: "tmpl_123",
        useWorktree: false,
        createNewBranch: false,
        baseBranch: "main",
        worktreeBranch: "feat/from-caller",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          useWorktree: false,
          createNewBranch: false,
          baseBranch: "main",
          worktreeBranch: "feat/from-caller",
        })
      );
    });

    it("keeps useWorktree false when the template does not ask for one", async () => {
      deps.templateService.getTemplate.mockResolvedValue(
        templateRecord({ useWorktree: false })
      );

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        templateId: "tmpl_123",
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          useWorktree: false,
          createNewBranch: false,
          baseBranch: undefined,
          worktreeBranch: undefined,
        })
      );
    });

    it("throws when the referenced template does not exist", async () => {
      deps.templateService.getTemplate.mockResolvedValue(null);

      await expect(
        handlers.launchAgent("agt_test1", {
          name: "child",
          prompt: "work",
          templateId: "tmpl_missing",
        })
      ).rejects.toThrow("Template tmpl_missing not found.");
      expect(deps.agentManager.createAgent).not.toHaveBeenCalled();
    });

    it("does not look up a template when no templateId is given", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
      });

      expect(deps.templateService.getTemplate).not.toHaveBeenCalled();
    });

    it("applies the instance-wide worktree location setting", async () => {
      deps.pool.query.mockResolvedValue({ rows: [{ value: "nested" }] });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        useWorktree: true,
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeLocation: "nested" })
      );
    });

    it("falls back to sibling when the worktree location setting is unset", async () => {
      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        useWorktree: true,
      });

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeLocation: "sibling" })
      );
    });

    // The `as never` is the point: it exercises the path an untyped MCP payload
    // would take, so this stays a runtime guard rather than a compile-time one.
    it("ignores a caller-supplied worktreeLocation", async () => {
      deps.pool.query.mockResolvedValue({ rows: [{ value: "nested" }] });

      await handlers.launchAgent("agt_test1", {
        name: "child",
        prompt: "work",
        useWorktree: true,
        worktreeLocation: "sibling",
      } as never);

      expect(deps.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeLocation: "nested" })
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

  describe("archiveAgent", () => {
    it("archives an agent the caller launched", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child1",
        name: "child",
        cwd: "/repo",
        parentAgentId: "agt_test1",
      } as any);

      const result = await handlers.archiveAgent("agt_test1", {
        agentId: "agt_child1",
      });

      expect(deps.beginBackgroundArchive).toHaveBeenCalledWith(
        "agt_child1",
        "auto",
        { startAfter: expect.any(Function) }
      );
      expect(result).toEqual({
        agentId: "agt_child1",
        name: "child",
        archiving: true,
      });
    });

    it("archives the caller's own session", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "test-agent",
        cwd: "/repo",
        parentAgentId: null,
      } as any);

      const result = await handlers.archiveAgent("agt_test1", {
        agentId: "agt_test1",
      });

      expect(deps.beginBackgroundArchive).toHaveBeenCalledWith(
        "agt_test1",
        "auto",
        { startAfter: expect.any(Function) }
      );
      expect(result).toEqual({
        agentId: "agt_test1",
        name: "test-agent",
        archiving: true,
      });
    });

    it("passes a custom cleanupWorktree mode through", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child1",
        name: "child",
        cwd: "/repo",
        parentAgentId: "agt_test1",
      } as any);

      await handlers.archiveAgent("agt_test1", {
        agentId: "agt_child1",
        cleanupWorktree: "force",
      });

      expect(deps.beginBackgroundArchive).toHaveBeenCalledWith(
        "agt_child1",
        "force",
        expect.anything()
      );
    });

    it("holds teardown until the response has been written", async () => {
      vi.useFakeTimers();
      try {
        deps.agentManager.getAgent.mockResolvedValue({
          id: "agt_test1",
          name: "test-agent",
          cwd: "/repo",
        } as any);
        let releaseResponse: () => void = () => {};
        const responseFinished = new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });

        await handlers.archiveAgent("agt_test1", {
          agentId: "agt_test1",
          whenResponseFinished: () => responseFinished,
        });

        const { startAfter } = deps.beginBackgroundArchive.mock.calls[0][2] as {
          startAfter: () => Promise<void>;
        };
        let started = false;
        void startAfter().then(() => {
          started = true;
        });

        // The response has not been written, so waiting alone never starts it.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(started).toBe(false);

        releaseResponse();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(started).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up waiting on the response rather than stalling the archive", async () => {
      vi.useFakeTimers();
      try {
        deps.agentManager.getAgent.mockResolvedValue({
          id: "agt_test1",
          name: "test-agent",
          cwd: "/repo",
        } as any);

        await handlers.archiveAgent("agt_test1", {
          agentId: "agt_test1",
          // A transport that never finishes the response.
          whenResponseFinished: () => new Promise<void>(() => {}),
        });

        const { startAfter } = deps.beginBackgroundArchive.mock.calls[0][2] as {
          startAfter: () => Promise<void>;
        };
        let started = false;
        void startAfter().then(() => {
          started = true;
        });

        await vi.advanceTimersByTimeAsync(4_000);
        expect(started).toBe(false);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(started).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws when the target agent is not found", async () => {
      deps.agentManager.getAgent.mockResolvedValue(null);

      await expect(
        handlers.archiveAgent("agt_test1", { agentId: "agt_missing" })
      ).rejects.toThrow("Agent not found.");
      expect(deps.beginBackgroundArchive).not.toHaveBeenCalled();
    });

    it("points a job agent at job_complete instead of archiving itself", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_test1",
        name: "nightly triage",
        cwd: "/repo",
      } as any);
      deps.jobService.getActiveRunForAgent.mockResolvedValue({
        id: "run_7",
        status: "running",
      } as any);

      await expect(
        handlers.archiveAgent("agt_test1", { agentId: "agt_test1" })
      ).rejects.toThrow(/active job run \(run_7\)[\s\S]*job_complete/);
      expect(deps.beginBackgroundArchive).not.toHaveBeenCalled();
    });

    it("blocks archiving a child that has an active job run too", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child1",
        name: "child",
        cwd: "/repo",
        parentAgentId: "agt_test1",
      } as any);
      deps.jobService.getActiveRunForAgent.mockResolvedValue({
        id: "run_8",
        status: "needs_input",
      } as any);

      await expect(
        handlers.archiveAgent("agt_test1", { agentId: "agt_child1" })
      ).rejects.toThrow("active job run (run_8)");
      expect(deps.beginBackgroundArchive).not.toHaveBeenCalled();
    });

    it("rejects archiving an agent the caller neither launched nor is", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_other1",
        name: "other",
        cwd: "/repo",
        parentAgentId: "agt_someone_else",
      } as any);

      await expect(
        handlers.archiveAgent("agt_test1", { agentId: "agt_other1" })
      ).rejects.toThrow(
        "You can only archive yourself or an agent you launched"
      );
      expect(deps.beginBackgroundArchive).not.toHaveBeenCalled();
    });

    it("archives an agent launched with child: false, which has no parent", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_indep1",
        name: "independent",
        cwd: "/repo",
        parentAgentId: null,
        launchedByAgentId: "agt_test1",
      } as any);

      await handlers.archiveAgent("agt_test1", { agentId: "agt_indep1" });

      expect(deps.beginBackgroundArchive).toHaveBeenCalledWith(
        "agt_indep1",
        "auto",
        expect.anything()
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
      expect(deps.enqueueAgentPrompt).toHaveBeenCalledWith(
        "agt_target1",
        `--- DISPATCH MESSAGE ---\n${JSON.stringify({
          from: "test-agent",
          senderId: "agt_test1",
          senderRelation: "unrelated",
          message: "hello",
          replyTarget: "agt_test1",
        })}\n--- END MESSAGE ---\nOptional reply channel: If a response is necessary, use dispatch_send_message with the replyTarget above. Do not acknowledge routine status updates or completion messages unless a reply is explicitly requested.`
      );
      expect(deps.enqueueAgentPrompt).not.toHaveBeenCalledWith(
        "agt_target1",
        expect.stringContaining(
          "Reply with dispatch_send_message using the replyTarget above."
        )
      );
      // The handler returns once the prompt is queued; it never waits on
      // the (possibly gated) pane write.
      expect(deps.sendAgentPrompt).not.toHaveBeenCalled();
    });

    it("surfaces the delegation chain when the sender is a grandchild", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_researcher",
        name: "researcher",
        cwd: "/repo",
        status: "running",
        parentAgentId: "agt_planner",
      } as any);
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_orchestrator",
          name: "orchestrator",
          cwd: "/repo",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_planner",
          name: "planner",
          cwd: "/repo",
          status: "running",
          parentAgentId: "agt_orchestrator",
        },
        {
          id: "agt_researcher",
          name: "researcher",
          cwd: "/repo",
          status: "running",
          parentAgentId: "agt_planner",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

      await handlers.sendMessage("agt_researcher", {
        target: "agt_orchestrator",
        message: "hello",
        senderRepoRoot: "/repo",
      });

      const prompt = deps.enqueueAgentPrompt.mock.calls[0][1] as string;
      const envelope = JSON.parse(
        prompt.slice(
          prompt.indexOf("\n") + 1,
          prompt.indexOf("\n--- END MESSAGE ---")
        )
      );
      expect(envelope.senderRelation).toBe("descendant");
      expect(envelope.delegationChain).toEqual([
        "researcher (agt_researcher)",
        "planner (agt_planner)",
        "orchestrator (agt_orchestrator)",
      ]);
      expect(prompt).toContain(
        "Provenance: researcher is not your direct child — delegation chain: " +
          "researcher (agt_researcher) -> planner (agt_planner) -> orchestrator (agt_orchestrator, you)."
      );
    });

    it("marks a direct child as a child and adds no provenance line", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child",
        name: "child",
        cwd: "/repo",
        status: "running",
        parentAgentId: "agt_parent",
      } as any);
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo",
          status: "running",
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

      await handlers.sendMessage("agt_child", {
        target: "agt_parent",
        message: "done",
        senderRepoRoot: "/repo",
      });

      const prompt = deps.enqueueAgentPrompt.mock.calls[0][1] as string;
      expect(prompt).toContain('"senderRelation":"child"');
      // The chain is [child, parent] and the recipient is the parent, so it adds
      // nothing the recipient did not already know.
      expect(prompt).not.toContain("Provenance:");
    });

    it("still reports the sender's own tree when the recipient is unrelated", async () => {
      deps.agentManager.getAgent.mockResolvedValue({
        id: "agt_child",
        name: "child",
        cwd: "/repo",
        status: "running",
        parentAgentId: "agt_parent",
      } as any);
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo",
          status: "running",
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo",
          status: "running",
          parentAgentId: "agt_parent",
        },
        {
          id: "agt_stranger",
          name: "stranger",
          cwd: "/repo",
          status: "running",
          parentAgentId: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

      await handlers.sendMessage("agt_child", {
        target: "agt_stranger",
        message: "fyi",
        senderRepoRoot: "/repo",
      });

      const prompt = deps.enqueueAgentPrompt.mock.calls[0][1] as string;
      expect(prompt).toContain('"senderRelation":"unrelated"');
      expect(prompt).toContain(
        "Provenance: child (agt_child) -> parent (agt_parent)."
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
        parentAgentId: null,
        parentName: null,
        relation: "unrelated",
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

    it("labels each agent's lineage relative to the caller", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "orchestrator",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_planner",
          name: "planner",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_self",
        },
        {
          id: "agt_researcher",
          name: "researcher",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_planner",
        },
        {
          id: "agt_stranger",
          name: "stranger",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_self", "/repo");
      expect(
        result.map((a) => [a.id, a.relation, a.parentAgentId, a.parentName])
      ).toEqual([
        ["agt_planner", "child", "agt_self", "orchestrator"],
        ["agt_researcher", "descendant", "agt_planner", "planner"],
        ["agt_stranger", "unrelated", null, null],
      ]);
    });

    it("redacts a parent the caller cannot address", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "self",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_hidden",
          name: "hidden-parent",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_peer",
          name: "peer",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_hidden",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_self", "/repo-a");
      expect(result.map((a) => a.id)).toEqual(["agt_peer"]);
      // agt_hidden is not addressable from /repo-a, so naming it here would
      // hand the caller an identity it is not allowed to address.
      expect(result[0].parentAgentId).toBeNull();
      expect(result[0].parentName).toBeNull();
    });

    it("still labels a descendant whose intermediate is unaddressable", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "orchestrator",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_planner",
          name: "planner",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_self",
        },
        {
          // Neither same-repo nor a direct child of the caller, so the
          // addressable set excludes it.
          id: "agt_subplanner",
          name: "subplanner",
          cwd: "/repo-b",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_planner",
        },
        {
          id: "agt_research",
          name: "researcher",
          cwd: "/repo-a",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_subplanner",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_self", "/repo-a");
      expect(result.map((a) => a.id)).toEqual(["agt_planner", "agt_research"]);
      const researcher = result.find((a) => a.id === "agt_research");
      // The relation is computed over every agent, so the descendant does not
      // flatten just because agt_subplanner sits in another repo — but
      // agt_subplanner itself is still not named.
      expect(researcher?.relation).toBe("descendant");
      expect(researcher?.parentAgentId).toBeNull();
      expect(researcher?.parentName).toBeNull();
    });

    it("names the caller as its own children's parent", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_self",
          name: "orchestrator",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_child",
          name: "child",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_self",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      // Self is excluded from the addressable set, but is not a secret from
      // itself — a caller's own children must still name their parent.
      const result = await handlers.listAgentsForAgent("agt_self", "/repo");
      expect(result[0].parentAgentId).toBe("agt_self");
      expect(result[0].parentName).toBe("orchestrator");
    });

    it("reports siblings launched by the same parent", async () => {
      deps.agentManager.listAgents.mockResolvedValue([
        {
          id: "agt_parent",
          name: "parent",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: null,
        },
        {
          id: "agt_self",
          name: "self",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
        {
          id: "agt_sibling",
          name: "sibling",
          cwd: "/repo",
          status: "running",
          latestEvent: null,
          parentAgentId: "agt_parent",
        },
      ]);
      vi.mocked(resolveRepoRoot).mockImplementation(
        async (cwd) => cwd as string
      );

      const result = await handlers.listAgentsForAgent("agt_self", "/repo");
      expect(result.map((a) => [a.id, a.relation])).toEqual([
        ["agt_parent", "parent"],
        ["agt_sibling", "sibling"],
      ]);
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

  describe("listMedia (own)", () => {
    it("returns media for agent", async () => {
      mockFamilyRows();
      const result = await handlers.listMedia("agt_test1", {});
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe("shot.png");
      expect(result[0].sizeBytes).toBe(10);
    });

    it("throws when agent not found", async () => {
      mockFamilyRows();
      await expect(handlers.listMedia("agt_missing", {})).rejects.toThrow(
        "Agent not found."
      );
    });

    it("filters by source when provided", async () => {
      mockFamilyRows();
      await handlers.listMedia("agt_test1", { source: "screenshot" });
      expect(deps.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("source = $2"),
        ["agt_test1", "screenshot"]
      );
    });

    it("omits source filter when not provided", async () => {
      mockFamilyRows();
      await handlers.listMedia("agt_test1", {});
      expect(deps.pool.query).toHaveBeenCalledWith(
        expect.not.stringContaining("source = $2"),
        ["agt_test1"]
      );
    });
  });
});
