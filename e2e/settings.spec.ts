import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Settings pane", () => {
  test("opens and closes the settings pane", async ({ page }) => {
    await loadApp(page);

    // Click the Settings button in the sidebar footer
    await page.getByTestId("settings-button").click();

    // Settings overlay should appear with a "Settings" heading and "Updates" nav item
    await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 3_000 });
    const releaseNav = page.getByRole("navigation").getByText("Updates");
    await expect(releaseNav).toBeVisible();

    // Close it via the X button (sr-only "Close")
    await page.getByRole("button", { name: "Close" }).click();

    // The Updates nav item should no longer be visible (pane is closed)
    await expect(releaseNav).not.toBeVisible({ timeout: 3_000 });
  });
});
