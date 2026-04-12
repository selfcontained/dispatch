import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Sidebar interactions", () => {
  test("closing and reopening the left sidebar", async ({ page }) => {
    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar).toBeVisible();

    // Close the sidebar using the chevron button inside it
    await sidebar.getByTitle("Close sidebar").click();

    // The sidebar wrapper collapses to width:0 with overflow:hidden.
    // Wait for the CSS transition to finish, then verify the wrapper has zero width.
    await page.waitForTimeout(400);
    const wrapper = sidebar.locator("..");
    const width = await wrapper.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThan(4);

    // Reopen using the header button
    await page.getByTitle("Open agent sidebar").click();

    // Create button should be visible again after the sidebar expands
    await expect(page.getByTestId("create-agent-button")).toBeVisible({ timeout: 3_000 });
  });

  test("Create button opens the create agent dialog", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();

    await expect(page.getByTestId("create-agent-form")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Create Agent")).toBeVisible();
  });

  test("mobile navigation back to agents opens the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadApp(page);

    await page.getByTitle("Open agent sidebar").click();
    await page.getByTestId("jobs-button").click();
    await expect(page).toHaveURL(/\/jobs$/);

    await page.getByTestId("agents-button").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("agent-sidebar")).toBeVisible();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
  });
});
