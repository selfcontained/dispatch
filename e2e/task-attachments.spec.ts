import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadApp, authHeaders } from "./helpers";

test("creates a task with an image and link, and reloads its saved context", async ({
  page,
  request,
}, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), "dispatch-task-context-"));
  execFileSync("git", ["init", "-q", repo]);
  const response = await request.post("/api/v1/projects", {
    headers: authHeaders(),
    data: { name: "Task context E2E", repoRoot: repo, color: "#7c6ee6" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json();
  try {
    await loadApp(page);
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByTestId("task-column-backlog")
      .getByRole("button", { name: "Add task" })
      .click();
    const dialog = page.getByTestId("task-create-dialog");
    await dialog.getByLabel("Title").fill("Task with image context");
    await dialog.getByTestId("task-context-files-input").setInputFiles({
      name: "context.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
        "base64"
      ),
    });
    await dialog.getByTestId("task-context-files-button").click();
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    await page
      .getByLabel("Link URL", { exact: true })
      .fill("https://example.com/task-context");
    await page.getByTestId("task-context-link-add").click();
    const created = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/v1/tasks") && res.request().method() === "POST"
    );
    await dialog
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    const taskResponse = await created;
    expect(taskResponse.request().headers()["content-type"]).toContain(
      "multipart/form-data"
    );
    expect(taskResponse.ok()).toBeTruthy();
    const drawer = page.getByTestId("task-drawer");
    await expect(
      drawer.getByRole("link", { name: "https://example.com/task-context" })
    ).toBeVisible();
    await expect(drawer.getByTestId("chat-attachment-image")).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(drawer.getByTestId("chat-attachment-image")).toBeVisible();
    await expect(
      drawer.getByRole("link", { name: "https://example.com/task-context" })
    ).toBeVisible();
    await testInfo.attach("saved task attachments", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await page.goto("about:blank");
    await request.delete(`/api/v1/projects/${project.id}`, {
      headers: authHeaders(),
    });
    rmSync(repo, { recursive: true, force: true });
  }
});
