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

import { registerFeedbackRoutes } from "../src/routes/feedback.js";
import * as feedbackQueries from "../src/agents/feedback.js";

vi.mock("../src/shared/git/worktree.js", () => ({
  resolveHeadSha: vi.fn(async () => "abc123"),
}));

vi.mock("../src/agents/feedback.js", () => ({
  listFeedback: vi.fn(),
  listFeedbackByParent: vi.fn(),
  updateFeedbackStatus: vi.fn(),
}));

const mockFeedback = {
  id: 1,
  agentId: "agt_test1",
  status: "open",
  message: "test feedback",
};

function createMockDeps() {
  return {
    pool: {} as never,
    agentManager: {
      getAgent: vi.fn(async () => ({ id: "agt_test1", cwd: "/tmp" })),
    },
    publishUiEvent: vi.fn(),
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
  await registerFeedbackRoutes(
    app,
    deps as unknown as Parameters<typeof registerFeedbackRoutes>[1]
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.agentManager.getAgent.mockResolvedValue({
    id: "agt_test1",
    cwd: "/tmp",
  });
  vi.mocked(feedbackQueries.listFeedback).mockResolvedValue([
    mockFeedback,
  ] as never);
  vi.mocked(feedbackQueries.listFeedbackByParent).mockResolvedValue([
    mockFeedback,
  ] as never);
  vi.mocked(feedbackQueries.updateFeedbackStatus).mockResolvedValue({
    ...mockFeedback,
    status: "fixed",
  } as never);
});

describe("GET /api/v1/agents/:id/feedback", () => {
  it("returns feedback for a valid agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents/agt_test1/feedback",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ feedback: [mockFeedback] });
    expect(deps.agentManager.getAgent).toHaveBeenCalledWith("agt_test1");
    expect(feedbackQueries.listFeedback).toHaveBeenCalledWith(
      deps.pool,
      "agt_test1"
    );
  });

  it("returns 404 when agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents/agt_missing/feedback",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Agent not found." });
  });

  it("calls listFeedbackByParent when scope=children", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents/agt_test1/feedback?scope=children",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ feedback: [mockFeedback] });
    expect(feedbackQueries.listFeedbackByParent).toHaveBeenCalledWith(
      deps.pool,
      "agt_test1"
    );
    expect(deps.agentManager.getAgent).not.toHaveBeenCalled();
  });

  it("calls handleAgentError on thrown errors", async () => {
    deps.agentManager.getAgent.mockRejectedValue(new Error("db fail"));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents/agt_test1/feedback",
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/agents/:id/feedback/:feedbackId", () => {
  it("updates feedback status to dismissed", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "dismissed" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "dismissed", {
      reason: null,
      resolutionCommit: null,
    });
  });

  it("updates feedback status to forwarded", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "forwarded" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "forwarded", {
      reason: null,
      resolutionCommit: null,
    });
  });

  it("updates feedback status to open", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "open" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "open", {
      reason: null,
      resolutionCommit: null,
    });
  });

  it("resolves head sha when status is fixed", async () => {
    const { resolveHeadSha } = await import("../src/shared/git/worktree.js");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "fixed" },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.agentManager.getAgent).toHaveBeenCalledWith("agt_test1");
    expect(resolveHeadSha).toHaveBeenCalledWith("/tmp");
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "fixed", {
      reason: null,
      resolutionCommit: "abc123",
    });
  });

  it("resolves head sha when status is ignored with reason", async () => {
    const { resolveHeadSha } = await import("../src/shared/git/worktree.js");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "ignored", reason: "not relevant" },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.agentManager.getAgent).toHaveBeenCalledWith("agt_test1");
    expect(resolveHeadSha).toHaveBeenCalledWith("/tmp");
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "ignored", {
      reason: "not relevant",
      resolutionCommit: "abc123",
    });
  });

  it("does not fetch agent or resolve sha for non-resolving statuses", async () => {
    const { resolveHeadSha } = await import("../src/shared/git/worktree.js");
    await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "dismissed" },
    });
    expect(deps.agentManager.getAgent).not.toHaveBeenCalled();
    expect(resolveHeadSha).not.toHaveBeenCalled();
  });

  it("publishes ui event on successful update", async () => {
    const dismissedFeedback = { ...mockFeedback, status: "dismissed" };
    vi.mocked(feedbackQueries.updateFeedbackStatus).mockResolvedValueOnce(
      dismissedFeedback
    );
    await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "dismissed" },
    });
    expect(deps.publishUiEvent).toHaveBeenCalledWith({
      type: "feedback.updated",
      agentId: "agt_test1",
      feedback: dismissedFeedback,
    });
  });

  it("returns 404 when feedback is not found", async () => {
    vi.mocked(feedbackQueries.updateFeedbackStatus).mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "dismissed" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Feedback not found." });
  });

  describe("validation", () => {
    it("rejects non-numeric feedback id", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/abc",
        payload: { status: "dismissed" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Invalid feedback id." });
    });

    it("rejects missing status", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/status must be one of/);
    });

    it("rejects invalid status value", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "invalid" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/status must be one of/);
    });

    it("rejects non-string status", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: 123 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/status must be one of/);
    });

    it("rejects reason exceeding 10,000 chars", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "dismissed", reason: "x".repeat(10_001) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/10,000 character limit/);
    });

    it("accepts reason at exactly 10,000 chars", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "dismissed", reason: "x".repeat(10_000) },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects non-string reason", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "dismissed", reason: 123 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/reason must be a string/);
    });

    it("allows null reason", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "dismissed", reason: null },
      });
      expect(res.statusCode).toBe(200);
    });

    it("allows omitted reason", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "dismissed" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("requires reason when status is ignored", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "ignored" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/reason is required.*ignored/i);
    });

    it("rejects whitespace-only reason when status is ignored", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "ignored", reason: "   " },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/reason is required.*ignored/i);
    });

    it("accepts non-empty reason when status is ignored", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/agt_test1/feedback/1",
        payload: { status: "ignored", reason: "not relevant" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("does not require reason for non-ignored statuses", async () => {
      for (const status of ["open", "dismissed", "forwarded", "fixed"]) {
        const res = await app.inject({
          method: "PATCH",
          url: "/api/v1/agents/agt_test1/feedback/1",
          payload: { status },
        });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  it("calls handleAgentError on thrown errors", async () => {
    vi.mocked(feedbackQueries.updateFeedbackStatus).mockRejectedValue(
      new Error("db fail")
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "dismissed" },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.handleAgentError).toHaveBeenCalled();
  });

  it("handles null resolutionCommit when agent is not found for resolving status", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agt_test1/feedback/1",
      payload: { status: "fixed" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      vi.mocked(feedbackQueries.updateFeedbackStatus)
    ).toHaveBeenCalledWith(deps.pool, 1, "agt_test1", "fixed", {
      reason: null,
      resolutionCommit: null,
    });
  });
});
