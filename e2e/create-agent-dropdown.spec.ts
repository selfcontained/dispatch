import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Create agent dialog", () => {
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

    // Select "Claude"
    await claudeOption.click();

    // The trigger should now show "Claude"
    await expect(typeTrigger).toContainText("Claude");

    // Close dialog
    await page.getByTestId("create-agent-cancel").click();
    await expect(form).not.toBeVisible({ timeout: 3_000 });
  });
});
