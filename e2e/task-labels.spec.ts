import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const headers = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
const repo = mkdtempSync(join(tmpdir(), "dispatch-labels-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
test("project labels persist, reuse colors and filter without changing capacity counts", async ({
  page,
  request,
}) => {
  const project = await (
    await request.post("/api/v1/projects", {
      headers,
      data: { name: "Labels", repoRoot: repo, color: "#336699" },
    })
  ).json();
  try {
    await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
      headers,
    });
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Labeled task");
    await page
      .getByRole("button", { name: "Edit labels", exact: true })
      .click();
    await page.getByLabel("Label name", { exact: true }).fill("Bug");
    await page.getByRole("combobox", { name: "Label color" }).click();
    await page.getByRole("option", { name: "red", exact: true }).click();
    await page
      .getByRole("button", { name: "Create “Bug”", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Edit labels", exact: true })
    ).toBeVisible();
    await expect(page).toHaveURL(/task=tsk_/);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: "Edit labels", exact: true })
    ).toHaveText("Labels (1)");
    const board = await (
      await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
        headers,
      })
    ).json();
    const task = board.tasks[0];
    expect(task.labels).toEqual([{ name: "Bug", color: "red" }]);
    const other = await (
      await request.post("/api/v1/tasks", {
        headers,
        data: { projectId: project.id, title: "Unlabeled task" },
      })
    ).json();
    const reuse = await (
      await request.patch(`/api/v1/tasks/${other.id}`, {
        headers,
        data: { labels: [{ name: "bug", color: "green" }] },
      })
    ).json();
    expect(reuse.labels).toEqual(task.labels);
    await request.patch(`/api/v1/tasks/${other.id}`, {
      headers,
      data: { labels: [] },
    });
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("combobox", { name: "Filter by label" }).click();
    await page.getByRole("option", { name: "Bug", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Labeled task", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Unlabeled task", exact: true })
    ).toHaveCount(0);
    expect(
      (
        await (
          await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
            headers,
          })
        ).json()
      ).columns[0].activeTaskCount
    ).toBe(2);
    await page.screenshot({ path: "/tmp/task-labels-e2e.png" });
    await page.getByRole("combobox", { name: "Filter by label" }).click();
    await page.getByRole("option", { name: "All labels", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Unlabeled task", exact: true })
    ).toBeVisible();
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});
