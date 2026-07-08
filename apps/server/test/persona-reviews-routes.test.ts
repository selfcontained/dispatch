import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { registerPersonaReviewRoutes } from "../src/routes/persona-reviews.js";
import { CLI_AGENT_TYPES } from "../src/agent-type-settings.js";

vi.mock("../src/personas/loader.js", () => ({
  loadPersonasFromRoots: vi.fn(async () => []),
}));

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async (cwd: string) => cwd),
  resolveWorktreeRoot: vi.fn(async (cwd: string) => cwd),
}));

vi.mock("../src/shared/git/worktree.js", () => ({
  resolveHeadSha: vi.fn(async () => "abc123"),
}));

vi.mock("../src/agent-type-settings.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEnabledAgentTypes: vi.fn(async () => [
      "claude",
      "codex",
      "cursor",
      "opencode",
    ]),
  };
});

function createMockDeps() {
  return {
    pool: {} as never,
    agentManager: {
      getAgent: vi.fn(async () => ({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })),
      getTerminalAccess: vi.fn(async () => ({ mode: "none" as const })),
      submitReviewResolution: vi.fn(async () => ({
        review: { id: 1 },
        resolution: { id: 1 },
      })),
    },
    mcpLaunchPersona: vi.fn(async () => ({
      agentId: "agt_child",
      persona: "security-review",
      parentAgentId: "agt_parent",
    })),
    mcpCancelRecheck: vi.fn(async () => {}),
    sendAgentPrompt: vi.fn(async () => {}),
    publishUiEvent: vi.fn(),
    withStreamFlag: vi.fn(<T extends Record<string, unknown>>(agent: T) => ({
      ...agent,
      hasStream: false,
    })),
    handleAgentError: vi.fn((reply: FastifyReply, error: unknown) =>
      reply.code(500).send({ error: String(error) })
    ),
  };
}

let app: FastifyInstance;
let deps: ReturnType<typeof createMockDeps>;

beforeAll(async () => {
  app = Fastify();
  deps = createMockDeps();
  await registerPersonaReviewRoutes(
    app,
    deps as unknown as Parameters<typeof registerPersonaReviewRoutes>[1]
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.agentManager.getAgent.mockResolvedValue({
    id: "agt_parent",
    name: "test-agent",
    cwd: "/tmp",
  });
  deps.agentManager.getTerminalAccess.mockResolvedValue({
    mode: "none" as const,
  });
  deps.mcpLaunchPersona.mockResolvedValue({
    agentId: "agt_child",
    persona: "security-review",
    parentAgentId: "agt_parent",
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/personas
// ---------------------------------------------------------------------------
describe("GET /api/v1/personas", () => {
  it("returns 400 when cwd is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personas",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cwd/);
  });

  it("returns personas array for a valid cwd", async () => {
    const { loadPersonasFromRoots } = await import("../src/personas/loader.js");
    vi.mocked(loadPersonasFromRoots).mockResolvedValueOnce([
      { slug: "security-review", name: "Security Review" },
    ] as never);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().personas).toHaveLength(1);
    expect(res.json().personas[0].slug).toBe("security-review");
  });

  it("loads personas from the resolved worktree and repo roots", async () => {
    const { loadPersonasFromRoots } = await import("../src/personas/loader.js");
    vi.mocked(loadPersonasFromRoots).mockResolvedValueOnce([
      { slug: "from-repo", name: "From Repo" },
    ] as never);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/tmp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().personas).toHaveLength(1);
    expect(res.json().personas[0].slug).toBe("from-repo");
    expect(loadPersonasFromRoots).toHaveBeenCalledWith({
      worktreeRoot: "/tmp",
      repoRoot: "/tmp",
    });
  });

  it("returns empty array on error", async () => {
    const { loadPersonasFromRoots } = await import("../src/personas/loader.js");
    vi.mocked(loadPersonasFromRoots).mockRejectedValueOnce(
      new Error("not a git repo")
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=/nonexistent",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().personas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/launch-review
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/launch-review", () => {
  it("returns 400 when persona is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { agentType: "codex" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/persona/);
  });

  it("returns 400 when persona is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "", agentType: "codex" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/persona/);
  });

  it("returns 400 for invalid persona slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "bad slug!", agentType: "codex" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/slug/);
  });

  it("returns 400 when agentType is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/agentType/);
  });

  it("returns 400 for invalid agentType", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review", agentType: "invalid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/agentType/);
  });

  it("returns 400 when includeDiff is not boolean", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: {
        persona: "security-review",
        agentType: "codex",
        includeDiff: "yes",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/includeDiff/);
  });

  it("returns 409 when agent has no tmux session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/tmux/);
  });

  it("sends prompt when agent has tmux session", async () => {
    deps.agentManager.getTerminalAccess.mockResolvedValueOnce({
      mode: "tmux" as const,
      session: "test-session",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
      "agt_parent",
      expect.stringContaining("security-review")
    );
  });

  it("includes includeDiff in prompt", async () => {
    deps.agentManager.getTerminalAccess.mockResolvedValueOnce({
      mode: "tmux" as const,
      session: "test-session",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: {
        persona: "security-review",
        agentType: "claude",
        includeDiff: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.sendAgentPrompt).toHaveBeenCalledWith(
      "agt_parent",
      expect.stringContaining("includeDiff: false")
    );
  });

  it("calls handleAgentError on thrown errors", async () => {
    deps.agentManager.getTerminalAccess.mockRejectedValueOnce(
      new Error("agent gone")
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/launch-review",
      payload: { persona: "security-review", agentType: "codex" },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });

  it("accepts all valid CLI agent types", async () => {
    for (const agentType of CLI_AGENT_TYPES) {
      deps.agentManager.getTerminalAccess.mockResolvedValueOnce({
        mode: "tmux" as const,
        session: "test-session",
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agt_parent/launch-review",
        payload: { persona: "security-review", agentType },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/persona-reviews
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/persona-reviews", () => {
  it("returns 400 when persona is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/persona/);
  });

  it("returns 400 when persona is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: " " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/persona/);
  });

  it("returns 400 for invalid persona slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "has spaces" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/slug/);
  });

  it("returns 400 for invalid agentType", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review", agentType: "invalid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/agentType/);
  });

  it("returns 400 when includeDiff is not boolean", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review", includeDiff: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/includeDiff/);
  });

  it("returns 400 when context is not a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review", context: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/context/);
  });

  it("returns 400 when includeDiff=false and context is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review", includeDiff: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/context is required/);
  });

  it("returns 400 when includeDiff=false and context is whitespace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: {
        persona: "security-review",
        includeDiff: false,
        context: "   ",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/context is required/);
  });

  it("returns 404 when parent agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_missing/persona-reviews",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it("returns 400 when requested agentType is disabled", async () => {
    const { getEnabledAgentTypes } =
      await import("../src/agent-type-settings.js");
    vi.mocked(getEnabledAgentTypes).mockResolvedValueOnce(["codex"] as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review", agentType: "claude" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/disabled/);
  });

  it("launches persona review successfully", async () => {
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "security-reviewer",
        cwd: "/tmp",
      });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe("agt_child");
    expect(deps.mcpLaunchPersona).toHaveBeenCalledWith("agt_parent", {
      persona: "security-review",
      context: expect.stringContaining("test-agent"),
      agentType: undefined,
      includeDiff: true,
    });
  });

  it("uses custom context when provided", async () => {
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "security-reviewer",
        cwd: "/tmp",
      });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: {
        persona: "security-review",
        context: "Review the auth module",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.mcpLaunchPersona).toHaveBeenCalledWith("agt_parent", {
      persona: "security-review",
      context: "Review the auth module",
      agentType: undefined,
      includeDiff: true,
    });
  });

  it("passes agentType and includeDiff to mcpLaunchPersona", async () => {
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "reviewer",
        cwd: "/tmp",
      });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: {
        persona: "security-review",
        agentType: "claude",
        includeDiff: false,
        context: "Check the auth flow",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.mcpLaunchPersona).toHaveBeenCalledWith("agt_parent", {
      persona: "security-review",
      context: "Check the auth flow",
      agentType: "claude",
      includeDiff: false,
    });
  });

  it("allows agentType to be omitted", async () => {
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "reviewer",
        cwd: "/tmp",
      });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("calls handleAgentError on thrown errors", async () => {
    deps.mcpLaunchPersona.mockRejectedValueOnce(new Error("launch failed"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });

  it("returns null agent when child lookup returns null", async () => {
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "test-agent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews",
      payload: { persona: "security-review" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeNull();
    expect(res.json().agentId).toBe("agt_child");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/persona-reviews/:personaAgentId/resolution
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/persona-reviews/:personaAgentId/resolution", () => {
  it("returns 400 when summary is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/summary/);
  });

  it("returns 400 when summary is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: { summary: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/summary/);
  });

  it("returns 400 when summary is whitespace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: { summary: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/summary/);
  });

  it("returns 404 when parent agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_missing/persona-reviews/agt_child/resolution",
      payload: { summary: "All issues resolved" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it("submits resolution successfully", async () => {
    const mockReview = { id: 1, status: "resolved" };
    const mockResolution = { id: 1, summary: "Fixed" };
    deps.agentManager.submitReviewResolution.mockResolvedValueOnce({
      review: mockReview,
      resolution: mockResolution,
    });
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "parent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "reviewer",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "parent",
        cwd: "/tmp",
      });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: { summary: "All issues resolved" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toEqual(mockReview);
    expect(res.json().resolution).toEqual(mockResolution);
    expect(deps.agentManager.submitReviewResolution).toHaveBeenCalledWith({
      parentAgentId: "agt_parent",
      personaAgentId: "agt_child",
      summary: "All issues resolved",
      resolutionCommit: "abc123",
    });
  });

  it("publishes ui events for child and parent", async () => {
    deps.agentManager.submitReviewResolution.mockResolvedValueOnce({
      review: { id: 1 },
      resolution: { id: 1 },
    });
    deps.agentManager.getAgent
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "parent",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_child",
        name: "reviewer",
        cwd: "/tmp",
      })
      .mockResolvedValueOnce({
        id: "agt_parent",
        name: "parent",
        cwd: "/tmp",
      });
    await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: { summary: "Done" },
    });
    expect(deps.publishUiEvent).toHaveBeenCalledTimes(2);
    expect(deps.publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.upsert" })
    );
  });

  it("calls handleAgentError on thrown errors", async () => {
    deps.agentManager.submitReviewResolution.mockRejectedValueOnce(
      new Error("review not found")
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/resolution",
      payload: { summary: "Done" },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/persona-reviews/:personaAgentId/cancel-recheck
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/persona-reviews/:personaAgentId/cancel-recheck", () => {
  it("returns 400 when reason is not a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      payload: { reason: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reason/);
  });

  it("cancels recheck with no reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(deps.mcpCancelRecheck).toHaveBeenCalledWith("agt_parent", {
      personaAgentId: "agt_child",
      reason: undefined,
    });
  });

  it("cancels recheck with a reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      payload: { reason: "Ship it" },
    });
    expect(res.statusCode).toBe(204);
    expect(deps.mcpCancelRecheck).toHaveBeenCalledWith("agt_parent", {
      personaAgentId: "agt_child",
      reason: "Ship it",
    });
  });

  it("trims whitespace-only reason to undefined", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      payload: { reason: "   " },
    });
    expect(res.statusCode).toBe(204);
    expect(deps.mcpCancelRecheck).toHaveBeenCalledWith("agt_parent", {
      personaAgentId: "agt_child",
      reason: undefined,
    });
  });

  it("calls handleAgentError on thrown errors", async () => {
    deps.mcpCancelRecheck.mockRejectedValueOnce(new Error("cancel failed"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });

  it("accepts null body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agt_parent/persona-reviews/agt_child/cancel-recheck",
      headers: { "content-type": "application/json" },
      payload: "null",
    });
    expect(res.statusCode).toBe(204);
  });
});
