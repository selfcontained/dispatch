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
    await page
      .getByTestId("task-column-backlog")
      .getByRole("button", { name: "Add task" })
      .click();
    const createDialog = page.getByTestId("task-create-dialog");
    await expect(
      createDialog.getByRole("combobox", { name: "Column" })
    ).toHaveText("Backlog");
    await createDialog.getByLabel("Title").fill("Write the release notes");
    await createDialog
      .getByLabel("Description")
      .fill("## Deliverable\nNotes for the release");
    await page.screenshot({
      path: "/tmp/dispatch-tasks-create.png",
      scale: "device",
    });
    await createDialog.getByLabel("Description").press("ControlOrMeta+Enter");
    await expect(createDialog).toHaveCount(0);
    await expect(
      page.getByTestId("task-drawer").getByRole("button", {
        name: "Write the release notes",
      })
    ).toBeVisible();
    await expect(
      page
        .getByTestId("task-column-backlog")
        .getByText("Write the release notes")
    ).toBeVisible();
    await page.getByRole("button", { name: "Close task" }).last().click();
    // The no-drag way across the board: the card's Move to… sheet.
    await page
      .getByRole("button", { name: "Write the release notes actions" })
      .click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page
      .getByTestId("task-move-sheet")
      .getByRole("button", { name: "Done" })
      .click();
    await expect(
      page.getByTestId("task-column-done").getByText("Write the release notes")
    ).toBeVisible();
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
      .getByRole("button", { name: task.title, exact: true })
      .click();
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(
      page.getByTestId("task-drawer").getByText("trigger launched")
    ).toBeVisible();
    const conversation = page.getByTestId("task-conversation");
    await conversation.scrollIntoViewIfNeeded();
    await expect(conversation).toBeVisible();
    await expect(
      page.getByTestId("task-drawer").getByText("Open conversation →")
    ).toHaveCount(0);
    await conversation
      .getByRole("textbox", { name: "Message the agent" })
      .fill("Progress from the task drawer");
    await conversation.getByTestId("chat-composer-send").click();
    await expect(
      conversation.getByText("Progress from the task drawer")
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
    await expect(
      page.getByTestId("task-column-ready").getByTitle(/Tasks builder/)
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Edit automation…" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/tasks?task=${task.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await page
      .getByTestId("task-drawer")
      .getByRole("button", { name: "Deliverable: task board" })
      .click();
    const description = page.getByTestId("task-drawer").locator("textarea");
    await description.fill("Description draft during refetch");
    const renameResponse = await request.patch(`/api/v1/tasks/${task.id}`, {
      headers,
      data: { title: "Renamed by an agent" },
    });
    expect(renameResponse.ok(), await renameResponse.text()).toBeTruthy();
    await expect(
      page.getByTestId("task-drawer").getByRole("button", {
        name: "Renamed by an agent",
      })
    ).toBeVisible();
    await expect(description).toHaveValue("Description draft during refetch");
    await page.screenshot({
      path: "/tmp/dispatch-tasks-draft-refetch.png",
      scale: "device",
    });
    const assigned = await (
      await request.get(`/api/v1/tasks/${task.id}`, { headers })
    ).json();
    expect(assigned.assignedAgentId).toBeTruthy();
    const drawer = page.getByTestId("task-drawer");
    await drawer.getByRole("combobox", { name: "Assignee" }).click();
    await page.getByRole("option", { name: "Unassigned" }).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/v1/tasks/${task.id}`, { headers })
            ).json()
          ).assignedAgentId
      )
      .toBeNull();
    await drawer.getByRole("combobox", { name: "Assignee" }).click();
    await page.getByRole("option").nth(1).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/v1/tasks/${task.id}`, { headers })
            ).json()
          ).assignedAgentId
      )
      .toBe(assigned.assignedAgentId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/agents/${assigned.assignedAgentId}?project=${project.id}`,
      { waitUntil: "domcontentloaded" }
    );
    await expect(page.getByTestId("agent-pane")).toBeVisible();
    await page.getByRole("button", { name: /^Task:/ }).click();
    const modal = page.getByTestId("task-modal");
    await expect(modal.getByText("Renamed by an agent").first()).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/agents/${assigned.assignedAgentId}\\?.*task=${task.id}`)
    );
    await page.screenshot({
      path: "/tmp/dispatch-tasks-mobile-modal.png",
      scale: "device",
    });
    await modal.getByRole("button", { name: "Close task" }).first().click();
    await expect(modal).toHaveCount(0);
    await expect(page).not.toHaveURL(/task=/);
    await expect(page.getByTestId("agent-pane")).toBeVisible();
    await page.getByRole("button", { name: /^Task:/ }).click();
    await modal.getByRole("link", { name: /Open in Tasks/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/tasks\\?task=${task.id}&project=${project.id}`)
    );
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await page.getByRole("button", { name: "Close task" }).first().click();
    await expect(page.getByTestId("task-drawer")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    // Boards are per project: the switcher offers no "All projects" here,
    // and an empty scope is a project picker.
    await page.getByRole("button", { name: "Filter by project" }).click();
    await expect(
      page.getByRole("menuitem", { name: "All projects" })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto("/tasks?project=");
    await expect(
      page.getByRole("heading", { name: "Choose a project" })
    ).toBeVisible();
    await page.getByRole("button", { name: project.name }).click();
    await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
    await expect(page.getByTestId("tasks-board")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-project-switch.png",
      scale: "device",
    });
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});
