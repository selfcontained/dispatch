import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, loadApp } from "./helpers";

test.describe("App shell", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("renders the main layout without dedicated header or footer chrome", async ({
    page,
  }) => {
    await loadApp(page);

    await expect(page.getByTestId("agent-sidebar")).toBeVisible();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await expect(page.getByTestId("status-footer")).toHaveCount(0);
    await expect(page.getByTestId("app-header")).toHaveCount(0);
  });

  test("shows the empty-state prompt when no agent is selected", async ({
    page,
  }) => {
    await loadApp(page);

    await expect(page.getByTestId("terminal-empty-state")).toBeVisible();
    await expect(page.getByTestId("terminal-empty-state")).toContainText(
      "Tap an agent row to focus it."
    );
  });

  test("settings rail reports healthy API and DB", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();

    // Settings nav is now in the sidebar — service status indicators are there too
    const sidebar = page.getByTestId("sidebar-shell");
    await expect(sidebar).toBeVisible();

    const apiDot = sidebar.getByTestId("service-dot-api");
    await expect(apiDot).toBeVisible();
    const apiStatus = sidebar.getByTestId("service-status-api");
    await expect(apiStatus).toContainText("ok", { timeout: 10_000 });

    const dbStatus = sidebar.getByTestId("service-status-db");
    await expect(dbStatus).toContainText("ok", { timeout: 10_000 });
  });

  test("bottom bar collapses, persists across reload, and expands back", async ({
    page,
  }) => {
    await loadApp(page);

    const toggle = page.getByTestId("bottom-bar-toggle");
    await expect(page.getByTestId("bottom-bar")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(page.getByTestId("bottom-bar")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
    await expect(page.getByTestId("bottom-bar")).toHaveCount(0);
    await expect(page.getByTestId("bottom-bar-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    await page.getByTestId("bottom-bar-toggle").click();
    await expect(page.getByTestId("bottom-bar")).toBeVisible();
  });

  test("sidebar shows the Dispatch logo", async ({ page }) => {
    await loadApp(page);

    const title = page
      .getByTestId("sidebar-shell")
      .getByText("Dispatch", { exact: true });
    await expect(title).toBeVisible();
  });
});
