import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

test.describe("Settings pane", () => {
  test.afterEach(async ({ request }) => {
    await setEnabledAgentTypesViaAPI(request, ["codex", "claude", "opencode"]);
    await request.post("/api/v1/notifications/settings", {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
      data: {
        webNotifyEnabled: false,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });
  });

  test("opens and closes the settings pane", async ({ page }) => {
    await loadApp(page);

    // Click the Settings button in the sidebar footer
    await page.getByTestId("settings-button").click();

    // Settings nav should appear in the sidebar with "General" nav item
    const sidebar = page.getByTestId("sidebar-shell");
    await expect(sidebar.getByText("Settings").first()).toBeVisible({
      timeout: 3_000,
    });
    const generalNav = sidebar.getByText("General");
    await expect(generalNav).toBeVisible();

    // Navigate back to agents to close settings
    await page.getByTestId("agents-button").click();

    // Settings nav should no longer be visible (back to agents view)
    await expect(generalNav).not.toBeVisible({ timeout: 3_000 });
  });

  test("shows version metadata in the Updates section", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Updates", { exact: true })
      .click();

    // Version info is displayed in the Updates section
    await expect(page.getByText("Current version")).toBeVisible();
    await expect(page.getByText("Release tag")).toBeVisible();
    await expect(page.getByText("Release channel")).toBeVisible();
  });

  test("agent type settings filter the create-agent dialog", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Agents", { exact: true })
      .click();

    const claudeToggle = page.getByTestId("agent-type-toggle-claude");
    await expect(claudeToggle).toBeChecked();
    await claudeToggle.uncheck();
    await expect(claudeToggle).not.toBeChecked();

    // Navigate back to agents to close settings
    await page.getByTestId("agents-button").click();

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const typeTrigger = form.getByRole("combobox").first();
    await expect(typeTrigger).toContainText("Codex");
    await typeTrigger.click();

    await expect(page.getByRole("option", { name: "Codex" })).toBeVisible();
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Claude" })
    ).not.toBeVisible();
  });

  test("single enabled agent type removes split buttons", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["codex"]);
    const agent = await createAgentViaAPI(request, {
      type: "codex",
      cwd: process.cwd(),
    });

    await loadApp(page);

    await expect(page.getByTestId("create-agent-button")).toBeVisible();
    await expect(page.getByTestId("create-agent-type-dropdown")).toHaveCount(0);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible();
    await agentCard.getByTestId(`agent-expand-toggle-${agent.id}`).click();

    await expect(agentCard.getByTestId("launch-reviewer-button")).toBeVisible();
    await expect(
      agentCard.getByTestId("launch-reviewer-type-dropdown")
    ).toHaveCount(0);
  });
});
