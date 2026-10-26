import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { deleteAgentViaAPI, loadApp, seedBlockViaDB } from "./helpers";
const headers = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
const repo = mkdtempSync(join(tmpdir(), "dispatch-tasks-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
// One Escape closes the trigger dialog as soon as focus reaches it, and
// focus goes back to whatever opened it.
async function escapeTriggerDialog(page: Page, opener: Locator) {
  const dialog = page.getByRole("dialog", { name: /^Trigger ·/ });
  await expect(
    dialog.getByRole("combobox", { name: "Template" })
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
}
// The menu-to-dialog hand-off, repeated: a freshly mounted dialog layer
// must take the first Escape every time, not only once it has settled.
async function cycleTriggerDialogFromMenu(page: Page, scope: Locator) {
  const menuButton = scope.getByRole("button", { name: "Ready menu" });
  for (let attempt = 0; attempt < 5; attempt++) {
    await menuButton.click();
    await page.getByRole("menuitem", { name: "Edit trigger…" }).click();
    await escapeTriggerDialog(page, menuButton);
  }
}
test("re-entering a trigger replaces an old failure with launch progress", async ({
  page,
  request,
}) => {
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Trigger lifecycle", repoRoot: repo, color: "#7c6ee6" },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  const board = await (
    await request.get(`/api/v1/projects/${project.id}/tasks/board`, { headers })
  ).json();
  const backlog = board.columns.find(
    (column: { key: string }) => column.key === "backlog"
  );
  const ready = board.columns.find(
    (column: { key: string }) => column.key === "ready"
  );
  const makeTemplate = async () => {
    const response = await request.post("/api/v1/templates", {
      headers,
      data: {
        name: "Lifecycle builder",
        directory: repo,
        projectId: project.id,
        agentType: "codex",
        prompt: "Work on {{D:Task Title}}",
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json();
  };
  const missing = await makeTemplate();
  const configure = async (templateId: string) => {
    const response = await request.patch(`/api/v1/task-columns/${ready.id}`, {
      headers,
      data: {
        trigger: {
          templateId,
          agentType: null,
          model: null,
          assign: true,
          fireOnCreate: false,
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await configure(missing.id);
  expect(
    (await request.delete(`/api/v1/templates/${missing.id}`, { headers })).ok()
  ).toBeTruthy();
  const taskResponse = await request.post("/api/v1/tasks", {
    headers,
    data: {
      projectId: project.id,
      columnId: backlog.id,
      title: "Retry launch",
    },
  });
  expect(taskResponse.ok()).toBeTruthy();
  const task = await taskResponse.json();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await loadApp(page);
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    const card = page.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Retry launch actions" }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page
      .getByTestId("task-move-sheet")
      .getByRole("button", { name: "Ready" })
      .click();
    await expect(card.getByText(/launch failed/)).toBeVisible();
    const valid = await makeTemplate();
    await configure(valid.id);
    expect(
      (
        await request.patch(`/api/v1/tasks/${task.id}`, {
          headers,
          data: { columnId: backlog.id },
        })
      ).ok()
    ).toBeTruthy();
    await expect(card.getByText(/launch failed/)).toHaveCount(0);

    // Hold this project's agent insert briefly so the published launch state
    // is observable; other workers' agents insert at full speed.
    await pool.query(`CREATE FUNCTION e2e_slow_task_launch() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER e2e_slow_task_launch BEFORE INSERT ON agents
      FOR EACH ROW WHEN (NEW.project_id = '${project.id}')
      EXECUTE FUNCTION e2e_slow_task_launch()`);
    const moving = request.patch(`/api/v1/tasks/${task.id}`, {
      headers,
      data: { columnId: ready.id },
    });
    await expect(card.getByTestId(`task-launching-${task.id}`)).toContainText(
      "Launching Lifecycle builder…"
    );
    await expect(card.getByText(/launch failed/)).toHaveCount(0);
    expect((await moving).ok()).toBeTruthy();
    await expect(card.locator("a[href*='/agents/']")).toBeVisible();
    await expect(card.getByTestId(`task-launching-${task.id}`)).toHaveCount(0);
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS e2e_slow_task_launch ON agents");
    await pool.query("DROP FUNCTION IF EXISTS e2e_slow_task_launch()");
    await pool.end();
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});
test("task moves into a triggered column, opens detail, and renders list on mobile", async ({
  page,
  request,
}) => {
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Tasks E2E", repoRoot: repo, color: "#7c6ee6" },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  let distractorId: string | undefined;
  try {
    // Keep a competing option ahead of the launched task agent even in an
    // isolated run. Selecting by list position must never restore assignment.
    const distractorResponse = await request.post("/api/v1/agents", {
      headers,
      data: {
        name: "AAA unrelated assignee",
        type: "codex",
        projectId: project.id,
        useWorktree: false,
      },
    });
    expect(
      distractorResponse.ok(),
      await distractorResponse.text()
    ).toBeTruthy();
    distractorId = (await distractorResponse.json()).agent.id;
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
    const list = page.getByTestId("tasks-list");
    await expect(list).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-list.png",
      scale: "device",
    });
    // A list group carries the board's column menu, trigger included.
    await list.getByRole("button", { name: "Ready menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Move up" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Edit trigger…" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
    await escapeTriggerDialog(
      page,
      list.getByRole("button", { name: "Ready menu" })
    );
    await cycleTriggerDialogFromMenu(page, list);
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
    // The column wears its trigger as a rule; clicking it edits.
    const strip = page.getByTestId("task-column-trigger-ready");
    await expect(strip).toContainText("launches Tasks builder");
    await page.getByRole("button", { name: "Ready menu" }).click();
    await page.getByRole("menuitem", { name: "Edit trigger…" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
    await escapeTriggerDialog(
      page,
      page.getByRole("button", { name: "Ready menu" })
    );
    await cycleTriggerDialogFromMenu(page, page.getByTestId("tasks-board"));
    await strip.click();
    await expect(page.getByRole("dialog")).toContainText(
      "already launches Tasks builder"
    );
    await page.screenshot({
      path: "/tmp/dispatch-tasks-trigger.png",
      scale: "device",
    });
    await escapeTriggerDialog(page, strip);
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
    await cycleTriggerDialogFromMenu(page, page.getByTestId("tasks-board"));
    await page.getByRole("button", { name: "List layout" }).click();
    await expect(page.getByTestId("tasks-list")).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-tasks-mobile-list.png",
      scale: "device",
    });
    await cycleTriggerDialogFromMenu(page, page.getByTestId("tasks-list"));
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
    await expect(
      page.getByRole("option").filter({
        has: page.getByTestId(`task-agent-chip-${distractorId}`),
      })
    ).toBeVisible();
    expect(distractorId).not.toBe(assigned.assignedAgentId);
    // Multiple task launches can leave several agents in this project.
    // Restore the original identity regardless of option ordering or names.
    await page
      .getByRole("option")
      .filter({
        has: page.getByTestId(`task-agent-chip-${assigned.assignedAgentId}`),
      })
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
    if (distractorId) await deleteAgentViaAPI(request, distractorId);
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

test("Tasks header controls keep their geometry across view toggles", async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-tasks-header-"));
  execFileSync("git", ["init", root]);
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: {
      name: "Tasks Header Geometry With A Rather Long Project Name E2E",
      repoRoot: root,
      color: "#7c6ee6",
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  const controls = [
    page.getByRole("button", { name: "Archived" }),
    page.getByRole("button", { name: "Board layout" }),
    page.getByRole("button", { name: "List layout" }),
    page.getByRole("textbox", { name: "Search tasks" }),
  ];
  const boxes = () =>
    Promise.all(
      controls.map((control) =>
        control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height].map(Math.round);
        })
      )
    );
  try {
    await loadApp(page);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/tasks?project=${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: "Board layout" }).click();
      await expect(
        page.getByRole("button", { name: "Board layout" })
      ).toHaveAttribute("aria-pressed", "true");
      const baseline = await boxes();
      await page.getByRole("button", { name: "List layout" }).click();
      await expect(
        page.getByRole("button", { name: "List layout" })
      ).toHaveAttribute("aria-pressed", "true");
      expect(await boxes()).toEqual(baseline);
      await page.getByRole("button", { name: "Archived" }).click();
      await expect(page).toHaveURL(/view=archived/);
      expect(await boxes()).toEqual(baseline);
      await page.getByRole("button", { name: "Archived" }).click();
      await expect(page).not.toHaveURL(/view=archived/);
      expect(await boxes()).toEqual(baseline);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
    }
  } finally {
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
    rmSync(root, { recursive: true, force: true });
  }
});

test.describe("iPad touch lock on the Tasks board", () => {
  test.use({
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });

  test("fast swipes from the grip and card surfaces scroll without dragging", async ({
    page,
    request,
  }) => {
    const response = await request.post("/api/v1/projects", {
      headers,
      data: { name: "Native grip scrolling", repoRoot: repo, color: "#7c6ee6" },
    });
    expect(response.ok()).toBeTruthy();
    const project = await response.json();
    try {
      const ids: string[] = [];
      for (let position = 0; position < 20; position++) {
        const task = await request.post("/api/v1/tasks", {
          headers,
          data: {
            projectId: project.id,
            title: `Scroll card ${position}`,
            position,
          },
        });
        expect(task.ok()).toBeTruthy();
        ids.push((await task.json()).id);
      }
      await page.goto(`/tasks?project=${project.id}&layout=board`, {
        waitUntil: "domcontentloaded",
      });
      const board = page.getByTestId("tasks-board");
      const column = page.getByTestId("task-column-backlog");
      const grip = page.getByRole("button", {
        name: "Drag Scroll card 0",
        exact: true,
      });
      await expect(grip).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      let lifted = false;
      page.on("console", (message) => {
        if (message.text() === "unexpected-scroll-drag") lifted = true;
      });
      // Observe even a transient activation, rather than only checking after release.
      await page.evaluate(() => {
        new MutationObserver(() => {
          if (document.querySelector('[data-testid="task-card-overlay"]'))
            console.log("unexpected-scroll-drag");
        }).observe(document.body, { childList: true, subtree: true });
      });
      const swipe = async (x: number, y: number, dx: number, dy: number) => {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 10; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: x + (dx * step) / 10, y: y + (dy * step) / 10 }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      const surfaces = [
        grip,
        page.getByRole("button", { name: "Scroll card 0", exact: true }),
        column.locator("header"),
        page.getByTestId("task-column-ready").locator(".overflow-y-auto"),
      ];
      for (const [index, surface] of surfaces.entries()) {
        await board.evaluate((el) => {
          el.scrollLeft = 0;
        });
        const box = (await surface.boundingBox())!;
        await swipe(
          box.x + box.width / 2,
          box.y + Math.min(box.height / 2, 100),
          -250,
          8
        );
        await expect
          .poll(() => board.evaluate((el) => el.scrollLeft))
          .toBeGreaterThan(150);
        expect(lifted).toBe(false);
        await expect(page.getByTestId("task-card-overlay")).toHaveCount(0);
        await page.screenshot({
          path: `/tmp/grip-scroll-${index}.png`,
          scale: "device",
        });
        // Let native momentum finish before resetting for the next surface.
        await page.waitForTimeout(500);
      }
      await board.evaluate((el) => {
        el.scrollLeft = 0;
      });
      const scroller = column.locator(".overflow-y-auto");
      const box = (await scroller.boundingBox())!;
      await swipe(box.x + box.width / 2, box.y + box.height - 60, 0, -250);
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(100);
      expect(lifted).toBe(false);
      await page.screenshot({
        path: "/tmp/grip-vertical.png",
        scale: "device",
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect
        .poll(() =>
          column
            .locator("[data-task-id]")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-task-id"))
            )
        )
        .toEqual(ids);
    } finally {
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
    }
  });

  test("a sideways swipe that lands slightly vertical still scrolls the board", async ({
    page,
    request,
  }) => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-tasks-ipad-"));
    execFileSync("git", ["init", root]);
    const projectResponse = await request.post("/api/v1/projects", {
      headers,
      data: { name: "Tasks iPad Swipe E2E", repoRoot: root, color: "#7c6ee6" },
    });
    expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
    const project = await projectResponse.json();
    try {
      const taskResponse = await request.post("/api/v1/tasks", {
        headers,
        data: { projectId: project.id, title: "Short column" },
      });
      expect(taskResponse.ok(), await taskResponse.text()).toBeTruthy();
      await page.goto(`/tasks?project=${project.id}&layout=board`, {
        waitUntil: "domcontentloaded",
      });
      const board = page.getByTestId("tasks-board");
      await expect(board).toBeVisible();
      await expect
        .poll(() => board.evaluate((el) => el.scrollWidth > el.clientWidth))
        .toBe(true);
      // Chromium never hands JS the first few pixels of a real touch, but
      // iOS does: replay that landing jitter straight at the lock, which
      // cancels the whole gesture once it calls preventDefault.
      const prevented = (testId: string, moves: [number, number][]) =>
        page.getByTestId(testId).evaluate((el, moves) => {
          const box = el.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const touch = (dx: number, dy: number) =>
            new Touch({
              identifier: 1,
              target: el,
              clientX: x + dx,
              clientY: y + dy,
            });
          const fire = (type: string, dx: number, dy: number) => {
            const t = touch(dx, dy);
            const event = new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: [t],
              targetTouches: [t],
              changedTouches: [t],
            });
            el.dispatchEvent(event);
            return event.defaultPrevented;
          };
          fire("touchstart", 0, 0);
          const result = moves.map(([dx, dy]) => fire("touchmove", dx, dy));
          el.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
          return result;
        }, moves);
      const ready = page.getByTestId("task-column-ready");
      await ready.locator("header").evaluate((el) => {
        el.dataset.testid = "ipad-ready-header";
      });
      await ready.locator(".overflow-y-auto").evaluate((el) => {
        el.dataset.testid = "ipad-ready-cards";
      });
      // Over a column too short to scroll, and over its header: the finger
      // settling a little downward is not yet a direction.
      expect(
        await prevented("ipad-ready-cards", [
          [1, 4],
          [-30, 6],
          [-120, 9],
        ])
      ).toEqual([false, false, false]);
      expect(
        await prevented("ipad-ready-header", [
          [-1, 3],
          [-40, 5],
        ])
      ).toEqual([false, false]);
      // The lock still holds a real vertical drag where nothing scrolls
      // vertically, jitter first or not.
      expect(
        await prevented("ipad-ready-header", [
          [1, 4],
          [2, 40],
        ])
      ).toEqual([false, true]);
      // And a real finger swipe moves the board both ways.
      const cdp = await page.context().newCDPSession(page);
      const swipe = async (fromX: number, toX: number, y: number) => {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: fromX, y }],
        });
        for (let step = 1; step <= 10; step++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              { x: fromX + ((toX - fromX) * step) / 10, y: y + step },
            ],
          });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      const boardBox = (await board.boundingBox())!;
      const scrollLeft = () => board.evaluate((el) => el.scrollLeft);
      const y = boardBox.y + boardBox.height / 2;
      await swipe(boardBox.x + boardBox.width - 30, boardBox.x + 30, y);
      await expect.poll(scrollLeft).toBeGreaterThan(150);
      const advanced = await scrollLeft();
      await swipe(boardBox.x + 30, boardBox.x + boardBox.width - 30, y);
      await expect.poll(scrollLeft).toBeLessThan(advanced - 150);
      await page.screenshot({
        path: "/tmp/dispatch-tasks-ipad-swipe.png",
        scale: "device",
      });
    } finally {
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch reorder" : "desktop reorder", () => {
    test.use({
      hasTouch: touch,
      isMobile: touch,
      viewport: touch
        ? { width: 820, height: 1180 }
        : { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    test("same-column preview stays stable and persists the chosen order", async ({
      page,
      request,
    }) => {
      test.setTimeout(60_000);
      const response = await request.post("/api/v1/projects", {
        headers,
        data: { name: "Stable reorder", repoRoot: repo, color: "#7c6ee6" },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const project = await response.json();
      try {
        const ids: string[] = [];
        for (const [position, title] of [
          "Alpha",
          "Bravo",
          "Charlie",
          "Delta",
          "Echo",
        ].entries()) {
          const task = await request.post("/api/v1/tasks", {
            headers,
            data: { projectId: project.id, title, position },
          });
          expect(task.ok()).toBeTruthy();
          ids.push((await task.json()).id);
        }
        await page.goto(`/tasks?project=${project.id}&layout=board`, {
          waitUntil: "domcontentloaded",
        });
        const column = page.getByTestId("task-column-backlog");
        const order = () =>
          column
            .locator("[data-task-id]")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-task-id"))
            );
        await expect.poll(order).toEqual(ids);
        const cdp = touch ? await page.context().newCDPSession(page) : null;
        const move = async (x: number, y: number) => {
          if (cdp)
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y }],
            });
          else await page.mouse.move(x, y);
        };
        const drag = async (
          from: string,
          to: string,
          downward: boolean,
          expected: string[]
        ) => {
          const grip = (await page
            .getByRole("button", { name: `Drag ${from}`, exact: true })
            .boundingBox())!;
          const target = (await column
            .locator("[data-task-id]")
            .filter({
              has: page.getByRole("button", { name: to, exact: true }),
            })
            .boundingBox())!;
          const start = {
            x: grip.x + grip.width / 2,
            y: grip.y + grip.height / 2,
          };
          const end = {
            x: target.x + target.width / 2,
            y: target.y + target.height * (downward ? 0.75 : 0.25),
          };
          if (cdp) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [start],
            });
            await page.waitForTimeout(250);
          } else {
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + 10, start.y);
          }
          await expect(page.getByTestId("task-card-overlay")).toBeVisible();
          for (let step = 1; step <= 30; step++)
            await move(
              start.x + ((end.x - start.x) * step) / 30,
              start.y + ((end.y - start.y) * step) / 30
            );
          await page.waitForTimeout(300);
          const geometry = () =>
            column
              .locator("[data-task-id]")
              .evaluateAll((els) =>
                els.map((el) => Math.round(el.getBoundingClientRect().y))
              );
          const preview = await geometry();
          for (let sample = 0; sample < 8; sample++) {
            await move(end.x + (sample % 2), end.y);
            await page.waitForTimeout(100);
            expect(await geometry()).toEqual(preview);
          }
          const previewOrder = await column
            .locator("[data-task-id]")
            .evaluateAll((els) =>
              els
                .map((el) => ({
                  id: el.getAttribute("data-task-id"),
                  y: el.getBoundingClientRect().y,
                }))
                .sort((a, b) => a.y - b.y)
                .map((item) => item.id)
            );
          expect(previewOrder).toEqual(expected);
          await page.screenshot({
            path: `/tmp/dispatch-reorder-${touch ? "touch" : "desktop"}-${from}-to-${to}-preview.png`,
            scale: "device",
          });
          if (cdp)
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
          else await page.mouse.up();
          await expect.poll(order).toEqual(expected);
          await expect
            .poll(async () => {
              const board = await (
                await request.get(
                  `/api/v1/projects/${project.id}/tasks/board`,
                  { headers }
                )
              ).json();
              return board.tasks.map((task: { id: string }) => task.id);
            })
            .toEqual(expected);
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect.poll(order).toEqual(expected);
        };
        await drag("Alpha", "Delta", true, [
          ids[1]!,
          ids[2]!,
          ids[3]!,
          ids[0]!,
          ids[4]!,
        ]);
        await drag("Alpha", "Bravo", false, ids);
        // Tied positions and adjacent IEEE doubles must not lose the insertion.
        for (const id of ids)
          await request.patch(`/api/v1/tasks/${id}`, {
            headers,
            data: { position: 1 },
          });
        await request.patch(`/api/v1/tasks/${ids[4]}`, {
          headers,
          data: { position: 1 + Number.EPSILON },
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(order).toEqual(ids);
        await drag("Echo", "Charlie", false, [
          ids[0]!,
          ids[1]!,
          ids[4]!,
          ids[2]!,
          ids[3]!,
        ]);
        let patches = 0;
        page.on("request", (request) => {
          if (
            request.method() === "PATCH" &&
            request.url().includes("/api/v1/tasks/")
          )
            patches++;
        });
        const reordered = [ids[0]!, ids[1]!, ids[4]!, ids[2]!, ids[3]!];
        await drag("Alpha", "Alpha", false, reordered);
        expect(patches).toBe(0);
        if (!touch) {
          await page
            .getByRole("button", { name: "Drag Alpha", exact: true })
            .focus();
          await page.keyboard.press("Space");
          await expect(page.getByTestId("task-card-overlay")).toBeVisible();
          // KeyboardSensor starts the overlay synchronously but installs its
          // document keydown handler in setTimeout(0). Cross one timer task
          // before sending the first direction key, even if the render is fast.
          await page.evaluate(
            () => new Promise<void>((resolve) => setTimeout(resolve, 0))
          );
          await page.keyboard.press("ArrowDown");
          await expect
            .poll(async () => {
              const alpha = await page
                .getByTestId(`task-card-${ids[0]}`)
                .boundingBox();
              const bravo = await page
                .getByTestId(`task-card-${ids[1]}`)
                .boundingBox();
              return alpha!.y > bravo!.y;
            })
            .toBe(true);
          await page.keyboard.press("Space");
          const keyboardOrder = [ids[1]!, ids[0]!, ids[4]!, ids[2]!, ids[3]!];
          await expect.poll(order).toEqual(keyboardOrder);
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect.poll(order).toEqual(keyboardOrder);
        }
        await page.screenshot({
          path: `/tmp/dispatch-reorder-${touch ? "touch" : "desktop"}-persisted.png`,
          scale: "device",
        });
        // Whitespace in a populated destination column still appends.
        const boardData = await (
          await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
            headers,
          })
        ).json();
        const readyId = boardData.columns.find(
          (item: { key: string }) => item.key === "ready"
        ).id;
        const readyIds: string[] = [];
        for (const [position, title] of [
          "Ready first",
          "Ready last",
        ].entries()) {
          const task = await request.post("/api/v1/tasks", {
            headers,
            data: { projectId: project.id, columnId: readyId, title, position },
          });
          expect(task.ok()).toBeTruthy();
          readyIds.push((await task.json()).id);
        }
        await page.reload({ waitUntil: "domcontentloaded" });
        const ready = page.getByTestId("task-column-ready");
        await expect(ready.locator("[data-task-id]")).toHaveCount(2);
        const grip = (await page
          .getByRole("button", { name: "Drag Alpha", exact: true })
          .boundingBox())!;
        const last = (await page
          .getByTestId(`task-card-${readyIds[1]}`)
          .boundingBox())!;
        const start = {
          x: grip.x + grip.width / 2,
          y: grip.y + grip.height / 2,
        };
        const end = { x: last.x + 30, y: last.y + last.height + 60 };
        if (cdp) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [start],
          });
          await page.waitForTimeout(250);
        } else {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x + 10, start.y);
        }
        await expect(page.getByTestId("task-card-overlay")).toBeVisible();
        for (let step = 1; step <= 30; step++)
          await move(
            start.x + ((end.x - start.x) * step) / 30,
            start.y + ((end.y - start.y) * step) / 30
          );
        await expect(ready).toHaveAttribute("data-drop-target", "true");
        if (cdp)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        else await page.mouse.up();
        const readyOrder = () =>
          ready
            .locator("[data-task-id]")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-task-id"))
            );
        await expect.poll(readyOrder).toEqual([...readyIds, ids[0]]);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(readyOrder).toEqual([...readyIds, ids[0]]);
        await page.screenshot({
          path: `/tmp/dispatch-reorder-${touch ? "touch" : "desktop"}-cross-column.png`,
          scale: "device",
        });
        await cdp?.detach();
      } finally {
        await request.delete(`/api/v1/projects/${project.id}`, { headers });
      }
    });
  });
}
