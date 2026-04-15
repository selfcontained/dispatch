import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

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

function createTestRepo(suffix: string): string {
  const barePath = `/tmp/dispatch-e2e-bare-${suffix}`;
  const repoPath = `/tmp/dispatch-e2e-repo-${suffix}`;
  rmSync(barePath, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });

  mkdirSync(barePath, { recursive: true });
  execSync("git init --bare", { cwd: barePath, stdio: "ignore" });
  execSync(`git clone "${barePath}" "${repoPath}"`, { stdio: "ignore" });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: repoPath,
    stdio: "ignore",
  });
  writeFileSync(`${repoPath}/README.md`, "# test\n");
  execSync("git add -A && git commit -m 'initial' && git push origin main", {
    cwd: repoPath,
    stdio: "ignore",
  });

  return repoPath;
}

function cleanupTestRepo(repoPath: string): void {
  const barePath = repoPath.replace("-repo-", "-bare-");
  try {
    const output = execSync("git worktree list --porcelain", { cwd: repoPath, encoding: "utf-8" });
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(repoPath)) {
        const wtPath = line.replace("worktree ", "").trim();
        try {
          execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoPath, stdio: "ignore" });
        } catch {
          rmSync(wtPath, { recursive: true, force: true });
        }
      }
    }
  } catch {
    // Repo may already be gone.
  }

  rmSync(repoPath, { recursive: true, force: true });
  rmSync(barePath, { recursive: true, force: true });
}

test.describe("Agent base branch", () => {
  const testId = `${process.pid}-${Date.now()}`;
  let repoPath: string;

  test.beforeAll(() => {
    repoPath = createTestRepo(testId);
  });

  test.afterAll(() => {
    cleanupTestRepo(repoPath);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

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

  test("sidebar details show main when a worktree agent has no baseBranch", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible({ timeout: 5_000 });

    await page.getByTestId(`agent-row-${agent.id}`).click();

    await expect(agentCard.getByText("Branch")).toBeVisible({ timeout: 5_000 });
    await expect(agentCard.getByText("main", { exact: true })).toBeVisible();
    await expect(agentCard.getByText(agent.worktreeBranch!, { exact: true })).toBeVisible();
  });
});
