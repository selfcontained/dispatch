import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadApp, authHeaders, createAgentViaAPI } from "./helpers";

const repo = mkdtempSync(join(tmpdir(), "dispatch-task-context-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("creates a task with an image and link, previews it, and keeps the modal open on Escape", async ({
  page,
  request,
}) => {
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
    const task = await taskResponse.json();
    const drawer = page.getByTestId("task-drawer");
    await expect(
      drawer.getByRole("link", { name: "https://example.com/task-context" })
    ).toBeVisible();
    await expect(drawer.getByTestId("chat-attachment-image")).toBeVisible();
    await drawer
      .getByTestId("chat-attachment-image")
      .getByRole("button")
      .click();
    await expect(page.getByTestId("file-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-lightbox")).toHaveCount(0);
    await expect(drawer).toBeVisible();
    const agent = await createAgentViaAPI(request, {
      cwd: repo,
      useWorktree: false,
    });
    await page.goto(`/agents/${agent.id}?task=${task.id}`, {
      waitUntil: "domcontentloaded",
    });
    const modal = page.getByTestId("task-modal");
    await modal
      .getByTestId("chat-attachment-image")
      .getByRole("button")
      .click();
    await expect(page.getByTestId("file-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-lightbox")).toHaveCount(0);
    await expect(modal).toBeVisible();
    await request.delete(`/api/v1/agents/${agent.id}`, {
      headers: authHeaders(),
    });
    const detailResponse = await request.get(`/api/v1/tasks/${task.id}`, {
      headers: authHeaders(),
    });
    const detail = await detailResponse.json();
    const range = await request.get(detail.attachments[0].url, {
      headers: { ...authHeaders(), Range: "bytes=0-7" },
    });
    expect(range.status()).toBe(206);
    expect(range.headers()["x-content-type-options"]).toBe("nosniff");
    expect((await range.body()).length).toBe(8);
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, {
      headers: authHeaders(),
    });
  }
});
