import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { authHeaders, deleteAgentViaAPI } from "./helpers";

test("create a task, move it to Ready and open its launched agent", async ({
  page,
  request,
}, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), "dispatch-task-journey-"));
  execFileSync("git", ["init", repo]);
  const headers = authHeaders();
  let projectId: string | undefined;
  let templateId: string | undefined;
  let agentId: string | undefined;
  try {
    const projectResponse = await request.post("/api/v1/projects", {
      headers,
      data: { name: "Task journey", repoRoot: repo, color: "#7c6ee6" },
    });
    expect(projectResponse.ok()).toBeTruthy();
    projectId = (await projectResponse.json()).id;
    const board = await (
      await request.get(`/api/v1/projects/${projectId}/tasks/board`, {
        headers,
      })
    ).json();
    const ready = board.columns.find(
      (column: { key: string }) => column.key === "ready"
    );
    const templateResponse = await request.post("/api/v1/templates", {
      headers,
      data: {
        name: "Task builder",
        directory: repo,
        projectId,
        agentType: "codex",
        prompt: "Work on {{D:Task Title}}",
      },
    });
    expect(templateResponse.ok()).toBeTruthy();
    templateId = (await templateResponse.json()).id;
    expect(
      (
        await request.patch(`/api/v1/task-columns/${ready.id}`, {
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
        })
      ).ok()
    ).toBeTruthy();

    await page.goto(`/tasks?project=${projectId}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByTestId("task-column-backlog")
      .getByRole("button", { name: "Add task" })
      .click();
    const dialog = page.getByTestId("task-create-dialog");
    await dialog.getByLabel("Title").fill("Ship the task journey");
    const created = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/v1/tasks") && res.request().method() === "POST"
    );
    await dialog
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    const response = await created;
    expect(response.ok()).toBeTruthy();
    const task = await response.json();
    await page.getByRole("button", { name: "Close task" }).last().click();
    const card = page.getByTestId(`task-card-${task.id}`);
    await card
      .getByRole("button", { name: "Ship the task journey actions" })
      .click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page
      .getByTestId("task-move-sheet")
      .getByRole("button", { name: "Ready", exact: true })
      .click();
    await expect(
      page.getByTestId("task-column-ready").getByTestId(`task-card-${task.id}`)
    ).toBeVisible();
    const link = card.locator("a[href*='/agents/']");
    await expect(link).toBeVisible();
    const saved = await (
      await request.get(`/api/v1/tasks/${task.id}`, { headers })
    ).json();
    agentId = saved.assignedAgentId;
    expect(agentId).toBeTruthy();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}`));
    await expect(page.getByTestId("harness-result").last()).toContainText(
      "Ship the task journey"
    );
    await testInfo.attach("task launched its agent", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    if (agentId) await deleteAgentViaAPI(request, agentId);
    if (templateId)
      await request.delete(`/api/v1/templates/${templateId}`, { headers });
    if (projectId)
      await request.delete(`/api/v1/projects/${projectId}`, { headers });
    await page.goto("about:blank");
    rmSync(repo, { recursive: true, force: true });
  }
});
