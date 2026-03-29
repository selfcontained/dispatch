import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

const AUTH_HEADER = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

test.describe("Agent CRUD", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("displays 'No agents yet' when the list is empty", async ({ page, request }) => {
    // Stop and delete only e2e-prefixed agents (never touch real agents)
    const listRes = await request.get("/api/v1/agents", { headers: AUTH_HEADER });
    const { agents } = (await listRes.json()) as { agents: Array<{ id: string; name: string; status: string }> };
    const e2eAgents = agents.filter((a) => a.name.startsWith("e2e-agent-"));
    for (const agent of e2eAgents) {
      if (agent.status !== "stopped") {
        await request.post(`/api/v1/agents/${agent.id}/stop`, { headers: AUTH_HEADER });
      }
    }
    for (const agent of e2eAgents) {
      await request.delete(`/api/v1/agents/${agent.id}`, { headers: AUTH_HEADER });
    }

    // Skip empty-state assertion if non-e2e agents remain
    if (agents.length > e2eAgents.length) {
      test.skip();
      return;
    }

    // Load page fresh — SSE snapshot should now be empty
    await loadApp(page);

    await expect(page.getByTestId("no-agents-message")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("no-agents-message")).toHaveText("No agents yet.");
  });

  test("create agent via UI — dialog opens, submits, and agent appears in sidebar", async ({
    page,
  }) => {
    await loadApp(page);

    // Open the create dialog
    await page.getByTestId("create-agent-button").click();

    // Dialog should be visible
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    // Fill in the form
    const agentName = `e2e-agent-${Date.now()}`;
    await page.getByTestId("create-agent-name").fill(agentName);
    await page.getByTestId("create-agent-cwd").fill("/tmp");

    // Submit
    await page.getByTestId("create-agent-submit").click();

    // Dialog should close
    await expect(form).not.toBeVisible({ timeout: 5_000 });

    // Agent should appear in the sidebar
    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(agentName)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("terminal-inert-state")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("terminal-inert-state")).toContainText("Agent running in inert mode");
  });

  test("cancel create dialog does not create an agent", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    await page.getByTestId("create-agent-cancel").click();
    await expect(form).not.toBeVisible({ timeout: 3_000 });
  });

  test("agent created via API appears in sidebar after SSE update", async ({
    page,
    request,
  }) => {
    await loadApp(page);

    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });

    // SSE should push the new agent to the UI
    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(agent.name)).toBeVisible({ timeout: 5_000 });
  });

  test("caret expands an agent without focusing it", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();

    await expect(agentCard.getByText("Working dir")).toBeVisible({ timeout: 3_000 });
    await expect(agentCard.getByText("/tmp")).toBeVisible();
    await expect(page.getByTestId("terminal-empty-state")).toBeVisible();
  });

  test("attached agent stays expanded while another agent is toggled open", async ({
    page,
    request,
  }) => {
    const attachedAgent = await createAgentViaAPI(request, { name: `e2e-agent-attached-${Date.now()}` });
    const peekAgent = await createAgentViaAPI(request, { name: `e2e-agent-peek-${Date.now()}` });

    await request.post(`/api/v1/agents/${attachedAgent.id}/start`, { headers: AUTH_HEADER });
    await request.post(`/api/v1/agents/${peekAgent.id}/start`, { headers: AUTH_HEADER });

    await loadApp(page);

    const attachedCard = page.getByTestId(`agent-card-${attachedAgent.id}`);
    const peekCard = page.getByTestId(`agent-card-${peekAgent.id}`);

    await page.getByTestId(`agent-row-${attachedAgent.id}`).click();
    await expect(page.getByTestId("detach-button")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId(`agent-expand-toggle-${attachedAgent.id}`)).toBeDisabled();
    await expect(attachedCard.getByText("Working dir")).toBeVisible({ timeout: 3_000 });

    await page.getByTestId(`agent-expand-toggle-${peekAgent.id}`).click();

    await expect(attachedCard.getByText("Working dir")).toBeVisible();
    await expect(peekCard.getByText("Working dir")).toBeVisible();
  });

  test("delete agent via overflow menu removes it from sidebar", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });
    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(agent.name)).toBeVisible({ timeout: 5_000 });

    // Click the Archive button on the agent card
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await page.getByTestId(`agent-archive-${agent.id}`).click();

    // Confirm the archive
    await page.getByTestId("delete-agent-confirm").click();

    // Agent should disappear from sidebar
    await expect(sidebar.getByText(agent.name)).not.toBeVisible({ timeout: 5_000 });
  });

  test("archiving the selected attached agent resets the terminal to empty state", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible({ timeout: 5_000 });

    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("detach-button")).toBeVisible({ timeout: 5_000 });

    await page.getByTestId(`agent-archive-${agent.id}`).click();
    await page.getByTestId("delete-agent-confirm").click();

    await expect(agentCard).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("terminal-empty-state")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("terminal-empty-state")).toContainText("Tap an agent row to focus it.");
    await expect(page.getByTestId("terminal-inert-state")).not.toBeVisible();
  });
});
