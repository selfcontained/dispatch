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

  test("shows version metadata in the App section", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page.getByRole("navigation").getByText("App", { exact: true }).click();

    await expect(page.getByTestId("app-version-card")).toBeVisible();
    await expect(page.getByTestId("app-version-semver")).not.toHaveText("");
    await expect(page.getByTestId("app-version-git-sha")).not.toHaveText("");
    await expect(page.getByTestId("app-version-release-notes")).not.toHaveText("");
  });
});
