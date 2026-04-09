import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Create agent dialog", () => {
  test("defaults the working directory to a non-empty value", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const cwdValue = await form.getByTestId("create-agent-cwd").inputValue();
    expect(cwdValue.length).toBeGreaterThan(0);
  });

  test("agent type dropdown opens and allows selection", async ({ page }) => {
    await loadApp(page);

    // Open the create dialog
    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    // The type select should default to "Codex"
    const typeTrigger = form.getByRole("combobox").first();
    await expect(typeTrigger).toContainText("Codex");

    // Click to open the dropdown
    await typeTrigger.click();

    // The dropdown options should be visible
    const claudeOption = page.getByRole("option", { name: "Claude" });
    await expect(claudeOption).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible({ timeout: 3_000 });

    // Select "Claude"
    await claudeOption.click();

    // The trigger should now show "Claude"
    await expect(typeTrigger).toContainText("Claude");

    // Close dialog
    await page.getByTestId("create-agent-cancel").click();
    await expect(form).not.toBeVisible({ timeout: 3_000 });
  });

  test("recent directories remain visible while typing a new path", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "dispatch:cwdHistory",
        JSON.stringify(["/tmp/existing-project", "/home/user/projects/myapp"])
      );
    });

    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const cwdInput = form.getByTestId("create-agent-cwd");
    await cwdInput.fill("/brand/new/path");
    const recentOptions = form.getByTestId("create-agent-cwd-history-option");

    await expect(page.getByRole("option", { name: "/home/user/projects/myapp" })).toBeVisible();
    await expect(page.getByRole("option", { name: "/tmp/existing-project" })).toBeVisible();
    await expect(recentOptions).toHaveCount(2);
    await expect(cwdInput).toHaveValue("/brand/new/path");
  });
});
