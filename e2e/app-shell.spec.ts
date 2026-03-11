import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, loadApp } from "./helpers";

test.describe("App shell", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("renders the main layout — sidebar, header, terminal pane, and status footer", async ({
    page,
  }) => {
    await loadApp(page);

    await expect(page.getByTestId("agent-sidebar")).toBeVisible();
    await expect(page.getByTestId("app-header")).toBeVisible();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await expect(page.getByTestId("status-footer")).toBeVisible();
  });

  test("shows the empty-state prompt when no agent is selected", async ({ page }) => {
    await loadApp(page);

    await expect(page.getByTestId("terminal-empty-state")).toBeVisible();
    await expect(page.getByTestId("terminal-empty-state")).toContainText(
      "Select an agent"
    );
  });

  test("status footer reports healthy API and DB", async ({ page }) => {
    await loadApp(page);

    // Wait for health poll to succeed (the dots turn green = bg-emerald-500)
    const apiDot = page.getByTestId("service-dot-api");
    await expect(apiDot).toBeVisible();
    // The status text eventually shows "ok"
    const apiStatus = page.getByTestId("service-status-api");
    await expect(apiStatus).toContainText("ok", { timeout: 10_000 });

    const dbStatus = page.getByTestId("service-status-db");
    await expect(dbStatus).toContainText("ok", { timeout: 10_000 });
  });

  test("sidebar shows the Dispatch logo", async ({ page }) => {
    await loadApp(page);

    const logo = page.getByTestId("agent-sidebar").locator('img[alt="Dispatch"]');
    await expect(logo).toBeVisible();
  });
});
