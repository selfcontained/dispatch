import { test, expect } from "@playwright/test";
import { createAgentViaAPI } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

/**
 * Helper to call the MCP tools/list endpoint for an agent and extract
 * the create_pr tool's baseBranch schema default.
 *
 * Note: MCP scoped routes validate agent-specific tokens, not the global
 * bearer token. In the E2E isolated environment (no password), omitting
 * the Authorization header lets the request through without token validation.
 */
async function getCreatePrBaseBranchDefault(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  agentId: string
): Promise<string | undefined> {
  const res = await request.fetch(`/api/mcp/${agentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  // MCP returns SSE — parse the event data line
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) return undefined;
  const json = JSON.parse(dataLine.slice("data: ".length));
  const createPr = json.result?.tools?.find((t: { name: string }) => t.name === "create_pr");
  return createPr?.inputSchema?.properties?.baseBranch?.default;
}

test.describe("Agent base branch", () => {
  test("POST /api/v1/agents persists baseBranch", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", baseBranch: "feature/foo", useWorktree: false },
    });
    const body = (await res.json()) as { agent: { baseBranch: string | null } };
    expect(body.agent.baseBranch).toBe("feature/foo");
  });

  test("POST /api/v1/agents defaults baseBranch to null", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", useWorktree: false },
    });
    const body = (await res.json()) as { agent: { baseBranch: string | null } };
    expect(body.agent.baseBranch).toBeNull();
  });

  test("POST /api/v1/agents validates baseBranch type", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", baseBranch: 123, useWorktree: false },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("baseBranch");
  });

  test("create_pr MCP tool defaults baseBranch from agent metadata", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", baseBranch: "develop", useWorktree: false, name: `e2e-agent-${Date.now()}` },
    });
    const body = (await res.json()) as { agent: { id: string; baseBranch: string | null } };
    expect(body.agent.baseBranch).toBe("develop");

    const baseBranchDefault = await getCreatePrBaseBranchDefault(request, body.agent.id);
    expect(baseBranchDefault).toBe("develop");
  });

  test("create_pr MCP tool defaults to main when agent has no baseBranch", async ({ request }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });

    const baseBranchDefault = await getCreatePrBaseBranchDefault(request, agent.id);
    expect(baseBranchDefault).toBe("main");
  });
});
