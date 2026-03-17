import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

test.describe("Agent CRUD", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("displays 'No agents yet' when the list is empty", async ({ page, request }) => {
    const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };
    // Stop and delete only e2e-prefixed agents (never touch real agents)
    const listRes = await request.get("/api/v1/agents", { headers: authHeader });
    const { agents } = (await listRes.json()) as { agents: Array<{ id: string; name: string; status: string }> };
    const e2eAgents = agents.filter((a) => a.name.startsWith("e2e-agent-"));
    for (const agent of e2eAgents) {
      if (agent.status !== "stopped") {
        await request.post(`/api/v1/agents/${agent.id}/stop`, { headers: authHeader });
      }
    }
    for (const agent of e2eAgents) {
      await request.delete(`/api/v1/agents/${agent.id}`, { headers: authHeader });
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

  test("selecting an agent expands its details in the sidebar", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });
    await loadApp(page);

    // Click the agent name to select it
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.getByText(agent.name).click();

    // The expanded card should show "Working dir" metadata
    await expect(agentCard.getByText("Working dir")).toBeVisible({ timeout: 3_000 });
    await expect(agentCard.getByText("/tmp")).toBeVisible();
  });

  test("delete agent via overflow menu removes it from sidebar", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-${Date.now()}` });
    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(agent.name)).toBeVisible({ timeout: 5_000 });

    // Open the overflow menu on the agent card
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.locator('[data-agent-control="true"]').last().click();

    // Click "Delete agent" from the overflow menu
    await page.getByText("Delete agent").click();

    // Confirm the deletion
    await page.getByTestId("delete-agent-confirm").click();

    // Agent should disappear from sidebar
    await expect(sidebar.getByText(agent.name)).not.toBeVisible({ timeout: 5_000 });
  });
});
