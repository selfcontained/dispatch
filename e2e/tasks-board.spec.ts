import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadApp } from "./helpers";
const headers = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
const repo = mkdtempSync(join(tmpdir(), "dispatch-tasks-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
test("task moves into automation, opens detail, and renders list on mobile", async ({
  page,
  request,
}) => {
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Tasks E2E", repoRoot: repo, color: "#7c6ee6" },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  try {
    const boardResponse = await request.get(
      `/api/v1/projects/${project.id}/tasks/board`,
      { headers }
    );
    expect(boardResponse.ok(), await boardResponse.text()).toBeTruthy();
    const board = await boardResponse.json();
    const backlog = board.columns.find(
      (column: { key: string }) => column.key === "backlog"
    );
    const ready = board.columns.find(
      (column: { key: string }) => column.key === "ready"
    );
    const templateResponse = await request.post("/api/v1/templates", {
      headers,
      data: {
        name: "Tasks builder",
        directory: repo,
        projectId: project.id,
        agentType: "codex",
        prompt: "Work on {{D:Task Title}}",
      },
    });
    expect(templateResponse.ok(), await templateResponse.text()).toBeTruthy();
    const template = await templateResponse.json();
    const triggerResponse = await request.patch(
      `/api/v1/task-columns/${ready.id}`,
      {
        headers,
        data: {
          trigger: {
            templateId: template.id,
            agentType: null,
            model: null,
            assign: true,
            passContext: true,
            fireOnCreate: false,
          },
        },
      }
    );
    expect(triggerResponse.ok(), await triggerResponse.text()).toBeTruthy();
    const taskResponse = await request.post("/api/v1/tasks", {
      headers,
      data: {
        projectId: project.id,
        columnId: backlog.id,
        title: "Build the task board",
        body: "Deliverable: task board",
      },
    });
    expect(taskResponse.ok(), await taskResponse.text()).toBeTruthy();
    const task = await taskResponse.json();
    await loadApp(page);
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId(`task-card-${task.id}`)).toBeVisible();
    await page.getByTestId(`task-card-${task.id}`).focus();
    await page.keyboard.press("]");
    await expect(
      page.getByTestId(`task-column-ready`).getByTestId(`task-card-${task.id}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`task-card-${task.id}`).locator("a[href*='/agents/']")
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-board.png",
      scale: "device",
    });
    await page
      .getByTestId(`task-card-${task.id}`)
      .getByRole("button", { name: task.title })
      .click();
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(
      page.getByTestId("task-drawer").getByText("trigger launched")
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-drawer.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Close task" }).click();
    await page.getByRole("button", { name: "List layout" }).click();
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-list.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Board layout" }).click();
    await page.getByRole("button", { name: "Ready menu" }).click();
    await page.getByRole("menuitem", { name: "Automation…" }).click();
    await expect(page.getByRole("dialog")).toContainText("Tasks builder");
    await page.screenshot({
      path: "/tmp/dispatch-tasks-automation.png",
      scale: "device",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "List layout" }).click();
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-mobile-list.png",
      scale: "device",
    });
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});
