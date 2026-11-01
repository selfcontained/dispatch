import { test, expect } from "@playwright/test";
import { authHeaders } from "./helpers";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`duplicate saved template, cancel, validate and retry at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const headers = authHeaders();
    const name = `Duplicate ${viewport.width} ${Date.now()}`;
    const source = await (
      await request.post("/api/v1/templates", {
        headers,
        data: {
          name,
          directory: "/tmp",
          prompt: "Saved prompt",
          description: "Saved description",
          agentType: "claude",
          model: "sonnet",
          useWorktree: true,
          baseBranch: "main",
          branchName: "copied-branch",
          callable: false,
          allowFiles: false,
          selfImprove: true,
        },
      })
    ).json();
    let copyId: string | undefined;
    let submissions = 0;
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/templates/${source.id}/duplicate`)
      )
        submissions++;
    });
    try {
      await page.goto(`/automations/templates/${source.id}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByPlaceholder("template name", { exact: true })
        .fill("Unsaved source name");
      await page
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Duplicate template",
        exact: true,
      });
      await expect(
        dialog.getByRole("button", { name: "Create template" })
      ).toBeDisabled();
      await dialog.getByLabel("New template name").fill("   ");
      await expect(
        dialog.getByRole("button", { name: "Create template" })
      ).toBeDisabled();
      await dialog.getByLabel("New template name").fill("Cancelled copy");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(submissions).toBe(0);
      await page
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();
      await dialog.getByLabel("New template name").fill(name);
      await dialog.getByRole("button", { name: "Create template" }).click();
      await expect(dialog.getByRole("alert")).toContainText("already exists");
      await dialog.getByLabel("New template name").fill(`${name} copy`);
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/templates/${source.id}/duplicate`) &&
          r.status() === 200
      );
      await dialog.getByRole("button", { name: "Create template" }).click();
      const copy = await (await response).json();
      copyId = copy.id;
      await expect(page).toHaveURL(
        new RegExp(`/automations/templates/${copy.id}$`)
      );
      await expect(
        page.getByRole("heading", { name: `${name} copy`, exact: true })
      ).toBeVisible();
      expect(submissions).toBe(2);
      const {
        id: _id,
        name: _name,
        createdAt: _created,
        updatedAt: _updated,
        ...config
      } = source;
      expect(copy).toMatchObject(config);
    } finally {
      if (copyId)
        await request.delete(`/api/v1/templates/${copyId}`, { headers });
      await request.delete(`/api/v1/templates/${source.id}`, { headers });
    }
  });
}
