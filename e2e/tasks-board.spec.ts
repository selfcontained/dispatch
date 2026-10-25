import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadApp, seedBlockViaDB } from "./helpers";
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
    await expect(
      page.getByRole("tab", { name: "Details", exact: true })
    ).toHaveAttribute("data-state", "active");
    const assignedTask = await (
      await request.get(`/api/v1/tasks/${task.id}`, { headers })
    ).json();
    const blockId = await seedBlockViaDB({
      streamId: task.id,
      authorKind: "agent",
      authorAgentId: assignedTask.assignedAgentId,
      text: "Unread task update",
    });
    await page.goto(
      `/tasks?project=${project.id}&task=${task.id}&pane=details`,
      { waitUntil: "domcontentloaded" }
    );
    await expect(page.getByLabel("1 unread posts")).toBeVisible();
    await page.getByRole("tab", { name: /^Conversation/ }).click();
    await expect(page.getByLabel("1 unread posts")).toHaveCount(0);
    await expect(page).toHaveURL(/pane=conversation/);
    await expect(conversation).toBeVisible();
    await expect(
      page.getByTestId("task-drawer").getByText("Open conversation →")
    ).toHaveCount(0);
    await conversation
      .getByRole("textbox", { name: "Message the agent" })
      .fill("Progress from the task drawer");
    await conversation.getByTestId("chat-composer-file-input").setInputFiles({
      name: "tab-switch.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Attachment retained across task tabs"),
    });
    await expect(
      conversation.getByTestId("chat-composer-attachments")
    ).toContainText("tab-switch.txt");
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(conversation).toBeHidden();
    await page.getByRole("tab", { name: /^Conversation/ }).click();
    await expect(
      conversation.getByTestId("chat-composer-attachments")
    ).toContainText("tab-switch.txt");
    await expect(conversation.getByText("Needs re-attaching")).toHaveCount(0);
    await expect(conversation.getByTestId("chat-composer-send")).toBeEnabled();
    const posted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/streams/${task.id}/blocks`) &&
        response.request().method() === "POST"
    );
    await conversation.getByTestId("chat-composer-send").click();
    const postResponse = await posted;
    expect(postResponse.ok(), await postResponse.text()).toBeTruthy();
    expect((await postResponse.json()).block.attachments).toEqual([
      expect.objectContaining({
        type: "file",
        fileName: expect.stringMatching(/^tab-switch.*\.txt$/),
      }),
    ]);
    await expect(
      conversation.getByTestId("chat-composer-attachments")
    ).toHaveCount(0);
    await expect(
      conversation.getByText(/^tab-switch.*\.txt$/).first()
    ).toBeVisible();
    await expect(
      conversation.getByText("Progress from the task drawer")
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-drawer.png",
      scale: "device",
    });
    await page.goto(
      `/tasks?project=${project.id}&task=${task.id}&block=${blockId}`,
      { waitUntil: "domcontentloaded" }
    );
    await expect(
      page.getByRole("tab", { name: /^Conversation/ })
    ).toHaveAttribute("data-state", "active");
    await page.getByRole("button", { name: "Close task" }).click();
    await page.getByRole("button", { name: "List layout" }).click();
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-list.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Board layout" }).click();
    // A sidebar column is a filter: the others fold away; again clears it.
    await page.getByTestId("task-nav-column-ready").click();
    await expect(page).toHaveURL(/column=ready/);
    await expect(page.getByTestId("task-column-backlog")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(page.getByTestId("task-column-ready")).not.toHaveAttribute(
      "aria-hidden",
      "true"
    );
    // A keyboard drag cannot land in a folded column — not even beside a
    // card there.
    const inProgress = board.columns.find(
      (column: { key: string }) => column.key === "in_progress"
    );
    const hiddenResponse = await request.post("/api/v1/tasks", {
      headers,
      data: {
        projectId: project.id,
        title: "Hidden neighbour",
        columnId: inProgress.id,
      },
    });
    expect(hiddenResponse.ok(), await hiddenResponse.text()).toBeTruthy();
    await page
      .getByTestId(`task-card-${task.id}`)
      .getByRole("button", { name: /^Drag/ })
      .focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("task-card-overlay")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    await page.keyboard.press("Space");
    await expect(page.getByTestId("task-card-overlay")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(
      (
        await (
          await request.get(`/api/v1/tasks/${task.id}`, { headers })
        ).json()
      ).columnId
    ).toBe(ready.id);
    await page.getByTestId("task-column-filter").click();
    await expect(page).not.toHaveURL(/column=/);
    await expect(page.getByTestId("task-column-backlog")).not.toHaveAttribute(
      "aria-hidden",
      "true"
    );
    // A sideways wheel over a column's cards scrolls the board.
    await page.setViewportSize({ width: 900, height: 700 });
    const backlogBox = (await page
      .getByTestId("task-column-backlog")
      .boundingBox())!;
    await page.mouse.move(
      backlogBox.x + backlogBox.width / 2,
      backlogBox.y + backlogBox.height / 2
    );
    await page.mouse.wheel(300, 0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector('[data-testid="tasks-board"]')!.scrollLeft
        )
      )
      .toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    // The column wears its automation as a rule; clicking it edits.
    const strip = page.getByTestId("task-column-automation-ready");
    await expect(strip).toContainText("launches Tasks builder");
    await page.getByRole("button", { name: "Ready menu" }).click();
    await page.getByRole("menuitem", { name: "Edit automation…" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
    // The menu's layer must be gone before Escape, or it eats the key.
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(
      0
    );
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await strip.click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
    await page.screenshot({
      path: "/tmp/dispatch-tasks-automation.png",
      scale: "device",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    // A layout picked on a phone sticks: away via the sidebar and back
    // (no ?layout= left in the URL), Board is still shown.
    await page.getByRole("button", { name: "Board layout" }).click();
    const navSidebar = page.getByRole("dialog", { name: "Navigation sidebar" });
    const navLeft = () =>
      navSidebar.evaluate((el) => Math.round(el.getBoundingClientRect().left));
    // Agents may open the sheet on its own as it lands; retry until open.
    const openNavSidebar = () =>
      expect(async () => {
        if ((await navLeft()) !== 0)
          await page.getByTitle("Open sidebar").click({ timeout: 1_000 });
        await expect.poll(navLeft, { timeout: 1_000 }).toBe(0);
      }).toPass({ timeout: 10_000 });
    await openNavSidebar();
    await navSidebar.getByTestId("agents-button").click();
    await expect(page).toHaveURL(/\/agents/);
    await openNavSidebar();
    await navSidebar.getByTestId("tasks-button").click();
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page).not.toHaveURL(/layout=/);
    // The Tasks tap lands on the board with the sheet closed.
    await expect.poll(navLeft).toBeLessThan(0);
    await expect(
      page.getByRole("button", { name: "Board layout" })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tasks-list")).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/dispatch-tasks-mobile-board-sticks.png",
      scale: "device",
    });
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
    // The first real agent: the launch entries carry a data-testid, agents
    // do not, and "Unassigned" is text.
    await page
      .locator('[role="option"]:not([data-testid])')
      .filter({ hasNotText: "Unassigned" })
      .first()
      .click();
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
    await expect(
      modal.getByRole("tab", { name: /^Conversation/ })
    ).toHaveAttribute("data-state", "active");
    await expect(modal.getByTestId("task-conversation")).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/agents/${assigned.assignedAgentId}\\?.*task=${task.id}`)
    );
    await modal
      .getByRole("textbox", { name: "Message the agent" })
      .fill("Phone draft");
    const composerFits = async () => {
      const send = await modal.getByTestId("chat-composer-send").boundingBox();
      const recipients = await modal
        .getByTestId("chat-composer-routing")
        .boundingBox();
      const sheet = await modal.boundingBox();
      return !!(
        send &&
        recipients &&
        sheet &&
        send.y + send.height <= sheet.y + sheet.height &&
        recipients.y + recipients.height <= sheet.y + sheet.height
      );
    };
    await expect.poll(composerFits).toBe(true);
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(composerFits).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
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
    // The layout last chosen for this project (List, above) comes back.
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-project-switch.png",
      scale: "device",
    });
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});

test("mobile Tasks nav lands on the list with the sidebar closed", async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-tasks-nav-"));
  execFileSync("git", ["init", root]);
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Tasks Nav E2E", repoRoot: root, color: "#7c6ee6" },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  try {
    await loadApp(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/settings/general?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    const sidebar = page.getByRole("dialog", { name: "Navigation sidebar" });
    const sidebarLeft = () =>
      sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().left));
    await page.getByTitle("Open sidebar").click();
    await expect.poll(sidebarLeft).toBe(0);
    // The nav sits in the sheet: a tap there is for the section's content.
    await sidebar.getByTestId("tasks-button").click();
    await expect(page).toHaveURL(new RegExp(`/tasks\\?project=${project.id}`));
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await expect.poll(sidebarLeft).toBeLessThan(0);
    await page.screenshot({
      path: "/tmp/dispatch-tasks-mobile-nav.png",
      scale: "device",
    });
    // The sheet is one tap away, and a column picked there hands the
    // screen back to the list.
    await page.getByTitle("Open sidebar").click();
    await expect.poll(sidebarLeft).toBe(0);
    await sidebar.getByTestId("task-nav-column-ready").click();
    await expect(page).toHaveURL(/column=ready/);
    await expect.poll(sidebarLeft).toBeLessThan(0);
    await expect(page.getByTestId("tasks-list")).toBeVisible();
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
    rmSync(root, { recursive: true, force: true });
  }
});
