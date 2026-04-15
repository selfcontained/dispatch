import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

async function expectMobileSidebarOpen(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Navigation sidebar" });
  await expect(dialog.getByTitle("Close sidebar")).toBeVisible();
  await expect
    .poll(async () => dialog.evaluate((el) => Math.round(el.getBoundingClientRect().left)))
    .toBe(0);
}

test.describe("Sidebar interactions", () => {
  test("closing and reopening the left sidebar", async ({ page }) => {
    await loadApp(page);

    const sidebar = page.getByTestId("sidebar-shell");
    await expect(sidebar).toBeVisible();

    // Close the sidebar using the chevron button inside it
    await sidebar.getByTitle("Close sidebar").click();

    // The GlassSidebar outer wrapper collapses to width:0 with overflow:hidden.
    // Wait for the CSS transition to finish, then verify the wrapper has zero width.
    await page.waitForTimeout(400);

    // The outermost wrapper of the GlassSidebar has the width transition
    // Structure: outer div (transition) > inner div (fixed width) > aside[sidebar-shell]
    await expect.poll(async () => {
      const shell = page.getByTestId("sidebar-shell");
      const outerWrapper = shell.locator("..").locator("..");
      return outerWrapper.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    }).toBeLessThan(4);

    // Reopen using the header button
    await page.getByTitle("Open sidebar").click();

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

    await page.getByTitle("Open sidebar").click();
    await expectMobileSidebarOpen(page);
    await page.getByTestId("jobs-button").click();
    await expect(page).toHaveURL(/\/jobs$/);

    // Sidebar auto-opens on mobile when switching sections — wait for it
    await expect(page.getByTestId("agents-button")).toBeVisible({ timeout: 3_000 });
    await page.getByTestId("agents-button").click();
    await expect(page).toHaveURL(/\/$/);
    await expectMobileSidebarOpen(page);
  });
});
