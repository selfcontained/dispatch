import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerMcpRoutes } from "../src/routes/mcp.js";

vi.mock("../src/shared/mcp/server.js", () => ({
  handleMcpRequest: vi.fn(),
}));

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async () => "/repo"),
  resolveWorktreeRoot: vi.fn(async () => "/repo"),
}));

vi.mock("../src/agents/telemetry.js", () => ({
  getActivitySummary: vi.fn(async () => ({})),
  getFeedbackSummary: vi.fn(async () => ({})),
}));

function createMockDeps() {
  return {
    config: { authToken: "test-auth-token" },
    pool: {} as never,
    agentManager: {
      getAgent: vi.fn(async () => ({
        id: "agt_test1",
        cwd: "/tmp/test",
        persona: null,
        parentAgentId: null,
        baseBranch: "main",
        status: "idle",
        name: "test-agent",
      })),
      listAgents: vi.fn(async () => []),
    },
    jobService: {
      listJobs: vi.fn(async () => []),
      getJobById: vi.fn(async () => null),
      getJobByName: vi.fn(async () => null),
      addJob: vi.fn(async () => ({ id: "job_1" })),
      updateJob: vi.fn(async () => ({ id: "job_1" })),
      removeJob: vi.fn(async () => undefined),
      runJob: vi.fn(async () => ({ id: "run_1" })),
      getActiveRunForAgent: vi.fn(async () => null),
    },
    templateService: {
      listTemplates: vi.fn(async () => []),
      getTemplate: vi.fn(async () => null),
      getTemplateByName: vi.fn(async () => null),
      addTemplate: vi.fn(async () => ({ id: "tpl_1" })),
      updateTemplate: vi.fn(async () => ({ id: "tpl_1" })),
      removeTemplate: vi.fn(async () => undefined),
    },
    brainStore: {} as never,
    publishBrainChanged: vi.fn(),
    getBearerToken: vi.fn(() => "bearer-token"),
    validateJobMcpToken: vi.fn(() => true),
    validateAgentMcpToken: vi.fn(() => true),
    mcpSendNotify: vi.fn(),
    mcpUpsertEvent: vi.fn(),
    mcpRenameSession: vi.fn(),
    mcpShareMedia: vi.fn(),
    mcpListMedia: vi.fn(),
    mcpSubmitFeedback: vi.fn(),
    mcpListPersonas: vi.fn(),
    mcpLaunchPersona: vi.fn(),
    mcpGetFeedback: vi.fn(),
    mcpResolveFeedback: vi.fn(),
    mcpSubmitResolution: vi.fn(),
    mcpCancelRecheck: vi.fn(),
    mcpUpsertPin: vi.fn(),
    mcpDeletePin: vi.fn(),
    mcpGetParentContext: vi.fn(),
    mcpGetRecheckContext: vi.fn(),
    mcpUpdateReviewStatus: vi.fn(),
    mcpCompleteReview: vi.fn(),
    mcpJobComplete: vi.fn(),
    mcpJobFailed: vi.fn(),
    mcpJobNeedsInput: vi.fn(),
    mcpJobLog: vi.fn(),
    mcpSendMessage: vi.fn(),
    mcpListAgentsForAgent: vi.fn(),
    mcpMethodNotAllowed: vi.fn(() => ({
      error: "Method not allowed. Use POST for MCP requests.",
    })),
  };
}

let app: FastifyInstance;
let deps: ReturnType<typeof createMockDeps>;

beforeAll(async () => {
  app = Fastify();
  deps = createMockDeps();
  await registerMcpRoutes(
    app,
    deps as unknown as Parameters<typeof registerMcpRoutes>[1]
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
    cwd: "/tmp/test",
    persona: null,
    parentAgentId: null,
    baseBranch: "main",
    status: "idle",
    name: "test-agent",
  });
  deps.getBearerToken.mockReturnValue("bearer-token");
  deps.validateJobMcpToken.mockReturnValue(true);
  deps.validateAgentMcpToken.mockReturnValue(true);
  deps.jobService.getActiveRunForAgent.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Method-not-allowed (405) routes
// ---------------------------------------------------------------------------

describe("GET /api/mcp", () => {
  it("returns 405", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("DELETE /api/mcp", () => {
  it("returns 405", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("GET /api/mcp/:agentId", () => {
  it("returns 405", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/agt_test1",
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

describe("DELETE /api/mcp/:agentId", () => {
  it("returns 405", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp/agt_test1",
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/method not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mcp/jobs/:runId/:agentId — auth and lookup branches
// ---------------------------------------------------------------------------

describe("POST /api/mcp/jobs/:runId/:agentId", () => {
  it("returns 403 when job MCP token is invalid", async () => {
    deps.validateJobMcpToken.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/invalid mcp token/i);
  });

  it("returns 404 when agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_missing",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/agent not found/i);
  });

  it("returns 403 when run ID does not match the active run", async () => {
    deps.jobService.getActiveRunForAgent.mockResolvedValue({
      id: "run_OTHER",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/does not match/i);
  });

  it("skips token validation when no bearer token is present", async () => {
    deps.getBearerToken.mockReturnValue(null);
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_1/agt_test1",
      payload: {},
    });
    // Token validation is skipped — the route continues to the agent lookup
    expect(deps.validateJobMcpToken).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mcp/:agentId — auth and lookup branches
// ---------------------------------------------------------------------------

describe("POST /api/mcp/:agentId", () => {
  it("returns 403 when agent MCP token is invalid", async () => {
    deps.validateAgentMcpToken.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/invalid mcp token/i);
  });

  it("returns 404 when agent is not found", async () => {
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_missing",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/agent not found/i);
  });

  it("returns 403 when agent has an active job run", async () => {
    deps.jobService.getActiveRunForAgent.mockResolvedValue({
      id: "run_active",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/job-scoped mcp route/i);
  });

  it("skips token validation when no bearer token is present", async () => {
    deps.getBearerToken.mockReturnValue(null);
    deps.agentManager.getAgent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/agt_test1",
      payload: {},
    });
    expect(deps.validateAgentMcpToken).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});
