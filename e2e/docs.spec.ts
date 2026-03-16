import { expect, test } from "@playwright/test";
import { loadApp } from "./helpers";

test.describe("Docs pane", () => {
  test("opens docs from the sidebar and switches sections", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("docs-button").click();

    const docsPane = page.getByTestId("docs-pane");
    await expect(docsPane).toBeVisible({ timeout: 3_000 });
    await expect(docsPane.getByRole("heading", { level: 2, name: "Agents" })).toBeVisible();

    await page.getByRole("button", { name: "Repo Tools" }).click();
    await expect(docsPane.getByRole("heading", { level: 2, name: "Repo Tools" })).toBeVisible();
    await expect(docsPane.getByRole("heading", { level: 3, name: "Defining tools" })).toBeVisible();

    await page.getByRole("button", { name: "Close" }).click();
    await expect(docsPane).not.toBeVisible({ timeout: 3_000 });
  });
});
