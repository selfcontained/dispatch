import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Create agent dialog", () => {
  test("defaults the working directory to a non-empty value", async ({
    page,
  }) => {
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

    // The type select should default to "Claude" (first alphabetically)
    const typeTrigger = form.getByRole("combobox").first();
    await expect(typeTrigger).toContainText("Claude");

    // Click to open the dropdown
    await typeTrigger.click();

    // The dropdown options should be visible
    const codexOption = page.getByRole("option", { name: "Codex" });
    await expect(codexOption).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible({
      timeout: 3_000,
    });

    // Select "Codex"
    await codexOption.click();

    // The trigger should now show "Codex"
    await expect(typeTrigger).toContainText("Codex");

    // Close dialog
    await page.getByTestId("create-agent-cancel").click();
    await expect(form).not.toBeVisible({ timeout: 3_000 });
  });

  test("recent directories filter by typed project name or path", async ({
    page,
  }) => {
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
    await cwdInput.fill("myapp");
    const recentOptions = form.getByTestId("create-agent-cwd-history-option");

    await expect(recentOptions).toHaveCount(1);
    await expect(recentOptions.first()).toContainText("myapp");
    await expect(cwdInput).toHaveValue("myapp");

    await cwdInput.press("ArrowDown");
    await expect(recentOptions.first()).toHaveAttribute(
      "data-selected",
      "true"
    );
    await cwdInput.press("Enter");
    await expect(cwdInput).toHaveValue("/home/user/projects/myapp");

    await cwdInput.fill("/tmp");
    await expect(
      recentOptions.filter({ hasText: "/tmp/existing-project" })
    ).toBeVisible();
  });
});
