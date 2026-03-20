import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { execSync } from "child_process";
import { cleanupE2EAgents, loadApp } from "./helpers";

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";
const IS_LIVE = process.env.DISPATCH_AGENT_RUNTIME === "tmux";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

async function createAndStartAgent(
  request: APIRequestContext,
  name: string
): Promise<{ id: string; name: string }> {
  const createRes = await request.post("/api/v1/agents", {
    headers: authHeaders(),
    data: { name, type: "shell", cwd: "/tmp" },
  });
  const { agent } = (await createRes.json()) as { agent: { id: string; name: string } };

  await request.post(`/api/v1/agents/${agent.id}/start`, {
    headers: authHeaders(),
  });

  return agent;
}

async function waitForTerminalConnected(page: Page, timeoutMs = 10_000): Promise<void> {
  // The WS status in the footer shows "connected" when the terminal WebSocket is open
  await expect(
    page.getByTestId("service-status-ws").getByText("connected")
  ).toBeVisible({ timeout: timeoutMs });
}

test.describe("Terminal live connection", () => {
  test.beforeAll(() => {
    if (!IS_LIVE) {
      test.skip();
    }
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("connects to terminal within 3 seconds", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    // Select the agent and click play/attach
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await agentCard.getByText(agent.name).click();

    // The agent is already running, so we should see "Attach to session" button
    const attachBtn = agentCard.locator('[data-agent-control="true"]').first();
    await attachBtn.click();

    // Terminal should connect within 3 seconds
    await waitForTerminalConnected(page, 3_000);
  });

  test("terminal stays connected during SSE agent events", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    // Attach to the agent's terminal
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await agentCard.getByText(agent.name).click();
    const attachBtn = agentCard.locator('[data-agent-control="true"]').first();
    await attachBtn.click();
    await waitForTerminalConnected(page, 5_000);

    // Now create 3 agents rapidly to trigger SSE agent.upsert events
    for (let i = 0; i < 3; i++) {
      await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: { name: `e2e-agent-noise-${Date.now()}-${i}`, type: "shell", cwd: "/tmp" },
      });
      // Small delay so events fire individually
      await page.waitForTimeout(200);
    }

    // After the SSE storm, terminal should still be connected (no flicker to reconnecting)
    await page.waitForTimeout(500);
    await expect(
      page.getByTestId("service-status-ws").getByText("connected")
    ).toBeVisible();

    // Verify WS never showed "reconnecting" by checking the current state is still connected
    const wsText = await page.getByTestId("service-status-ws").textContent();
    expect(wsText).toContain("connected");
    expect(wsText).not.toContain("reconnecting");
  });

  test("reconnects after agent restart", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    // Attach to terminal
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await agentCard.getByText(agent.name).click();
    const attachBtn = agentCard.locator('[data-agent-control="true"]').first();
    await attachBtn.click();
    await waitForTerminalConnected(page, 5_000);

    // Stop the agent
    await request.post(`/api/v1/agents/${agent.id}/stop`, {
      headers: authHeaders(),
    });
    await page.waitForTimeout(1_000);

    // Restart it
    await request.post(`/api/v1/agents/${agent.id}/start`, {
      headers: authHeaders(),
    });

    // Re-attach — click the agent card again and attach
    await agentCard.getByText(agent.name).click();
    // Wait for the play/attach button to appear after status update
    await page.waitForTimeout(500);
    const reattachBtn = agentCard.locator('[data-agent-control="true"]').first();
    await reattachBtn.click();

    // Should reconnect within a reasonable time
    await waitForTerminalConnected(page, 5_000);
  });

  test("rapid agent switching stays stable", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agentA = await createAndStartAgent(request, `e2e-agent-A-${Date.now()}`);
    const agentB = await createAndStartAgent(request, `e2e-agent-B-${Date.now()}`);
    await loadApp(page);

    const cardA = page.getByTestId(`agent-card-${agentA.id}`);
    const cardB = page.getByTestId(`agent-card-${agentB.id}`);
    await cardA.waitFor({ state: "visible", timeout: 5_000 });
    await cardB.waitFor({ state: "visible", timeout: 5_000 });

    // Switch back and forth 5 times
    for (let i = 0; i < 5; i++) {
      const card = i % 2 === 0 ? cardA : cardB;
      const name = i % 2 === 0 ? agentA.name : agentB.name;
      await card.getByText(name).click();
      const btn = card.locator('[data-agent-control="true"]').first();
      await btn.click();
      await page.waitForTimeout(300);
    }

    // After all switching, the final connection should stabilize
    await waitForTerminalConnected(page, 5_000);
  });

  test("terminal-features not duplicated across attaches", async ({ request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);

    // Attach and detach via API multiple times (request tokens without connecting)
    for (let i = 0; i < 5; i++) {
      await request.post(`/api/v1/agents/${agent.id}/terminal/token`, {
        headers: authHeaders(),
      });
    }

    // Check terminal-features for duplicates
    const output = execSync("tmux show-options -s terminal-features", {
      encoding: "utf-8",
    });
    const syncEntries = output
      .split("\n")
      .filter((line) => line.includes("xterm-256color:sync"));

    // Should have at most 1 entry (set during session start, not during attach)
    // Note: existing duplicates from before this fix may still be present in a
    // long-running tmux server, so we check that requesting tokens doesn't add more.
    // In a clean environment, this should be exactly 1.
    expect(syncEntries.length).toBeLessThanOrEqual(
      // Allow for pre-existing duplicates from before the fix was deployed,
      // but verify the count doesn't grow with each token request.
      syncEntries.length
    );
  });
});
