import { describe, expect, it, vi } from "vitest";

import { createDispatchMcpServer, type JobTools, type McpAgent, type McpRequestContext } from "../../../packages/shared/src/mcp/server.js";
import { buildAgentMcpContext, buildJobMcpContext } from "../src/mcp-context.js";

const agent: McpAgent = {
  id: "agt_test123456",
  cwd: "/tmp",
};

const sharedCallbacks = {
  shareMedia: vi.fn(async () => ({ fileName: "test.txt", url: "http://localhost/test.txt", sizeBytes: 1, source: "text", description: "test" })),
  submitFeedback: vi.fn(async () => ({ id: 1 })),
  launchPersona: vi.fn(async () => ({ agentId: "agt_child", persona: "security-review", parentAgentId: "agt_test123456" })),
  getFeedback: vi.fn(async () => ({ personas: [] })),
  resolveFeedback: vi.fn(async () => ({
    id: 1,
    severity: "medium",
    description: "x",
    filePath: null,
    lineNumber: null,
    suggestion: null,
    mediaRef: null,
    status: "fixed",
    createdAt: new Date(0).toISOString(),
  })),
  upsertPin: vi.fn(async () => {}),
  deletePin: vi.fn(async () => {}),
  getParentContext: vi.fn(async () => ({ pins: [], media: [] })),
  updateReviewStatus: vi.fn(async () => {}),
  completeReview: vi.fn(async () => {}),
} satisfies Pick<
  McpRequestContext,
  | "shareMedia"
  | "submitFeedback"
  | "launchPersona"
  | "getFeedback"
  | "resolveFeedback"
  | "upsertPin"
  | "deletePin"
  | "getParentContext"
  | "updateReviewStatus"
  | "completeReview"
>;

const jobTools: JobTools = {
  complete: vi.fn(async () => ({ runId: "run_123", status: "completed" })),
  failed: vi.fn(async () => ({ runId: "run_123", status: "failed" })),
  needsInput: vi.fn(async () => ({ runId: "run_123", status: "needs_input" })),
  log: vi.fn(async () => ({ runId: "run_123", status: "running" })),
  listAgents: vi.fn(async () => []),
  listRecentPersonaReviews: vi.fn(async () => []),
  listRecentFeedback: vi.fn(async () => []),
};

function toolNames(server: Awaited<ReturnType<typeof createDispatchMcpServer>>): string[] {
  return Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

describe("MCP context wiring", () => {
  it("keeps dispatch_event off job agents while exposing newer shared tools", async () => {
    const context = buildJobMcpContext({
      agent,
      repoRoot: null,
      worktreeRoot: null,
      ...sharedCallbacks,
      jobTools,
    });

    const names = toolNames(await createDispatchMcpServer(context));

    expect(names).toContain("job_log");
    expect(names).toContain("job_complete");
    expect(names).toContain("dispatch_pin");
    expect(names).toContain("dispatch_share");
    expect(names).toContain("dispatch_launch_persona");
    expect(names).toContain("dispatch_get_feedback");
    expect(names).toContain("dispatch_resolve_feedback");
    expect(names).not.toContain("dispatch_event");
    expect(names).not.toContain("create_pr");
    expect(names).not.toContain("get_pr_status");
  });

  it("keeps standard agent lifecycle tools on non-job agents", async () => {
    const context = buildAgentMcpContext({
      agent,
      repoRoot: null,
      worktreeRoot: null,
      upsertEvent: vi.fn(async () => {}),
      ...sharedCallbacks,
    });

    const names = toolNames(await createDispatchMcpServer(context));

    expect(names).toContain("dispatch_event");
    expect(names).toContain("dispatch_pin");
    expect(names).toContain("dispatch_share");
    expect(names).toContain("create_pr");
    expect(names).toContain("get_pr_status");
    expect(names).not.toContain("job_log");
  });
});
