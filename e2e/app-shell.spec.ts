import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, loadApp } from "./helpers";

test.describe("App shell", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("renders the main layout without dedicated header or footer chrome", async ({ page }) => {
    await loadApp(page);

    await expect(page.getByTestId("agent-sidebar")).toBeVisible();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await expect(page.getByTestId("status-footer")).toHaveCount(0);
    await expect(page.getByTestId("app-header")).toHaveCount(0);
  });

  test("shows the empty-state prompt when no agent is selected", async ({ page }) => {
    await loadApp(page);

    await expect(page.getByTestId("terminal-empty-state")).toBeVisible();
    await expect(page.getByTestId("terminal-empty-state")).toContainText(
      "Tap an agent row to focus it."
    );
  });

  test("settings rail reports healthy API and DB", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    const apiDot = dialog.getByTestId("service-dot-api");
    await expect(apiDot).toBeVisible();
    const apiStatus = dialog.getByTestId("service-status-api");
    await expect(apiStatus).toContainText("ok", { timeout: 10_000 });

    const dbStatus = dialog.getByTestId("service-status-db");
    await expect(dbStatus).toContainText("ok", { timeout: 10_000 });
  });

  test("sidebar shows the Dispatch logo", async ({ page }) => {
    await loadApp(page);

    const title = page.getByTestId("agent-sidebar").getByText("Dispatch", { exact: true });
    await expect(title).toBeVisible();
  });
});
