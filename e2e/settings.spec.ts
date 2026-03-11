import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Settings pane", () => {
  test("opens and closes the settings pane", async ({ page }) => {
    await loadApp(page);

    // Click the Settings button in the sidebar footer
    await page.getByTestId("settings-button").click();

    // Settings overlay should appear with a "Settings" heading and "Release" nav item
    await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Release", { exact: true })).toBeVisible();

    // Close it via the X button (sr-only "Close")
    await page.getByRole("button", { name: "Close" }).click();

    // The Release nav item should no longer be visible (pane is closed)
    await expect(page.getByText("Release", { exact: true })).not.toBeVisible({ timeout: 3_000 });
  });
});
