import { expect, test } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Docs pane", () => {
  test("opens docs from settings and switches sections", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page.getByRole("button", { name: "Help" }).click();

    await expect(page.getByRole("heading", { level: 2, name: "Agents" })).toBeVisible({ timeout: 3_000 });

    await page.getByRole("button", { name: "Repo Tools" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Repo Tools" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Defining tools" })).toBeVisible();
  });
});
