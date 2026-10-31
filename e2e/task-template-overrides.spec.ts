import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, cleanupE2EAgents, loadApp, trackAgent } from "./helpers";

test.use({ deviceScaleFactor: 2 });

const repo = mkdtempSync(join(tmpdir(), "dispatch-stage-templates-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

for (const layout of ["desktop", "mobile"] as const) {
  test(`task stage templates create, edit, clear, preview and launch on ${layout}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    mkdirSync(`${repo}/${layout}`, { recursive: true });
    await page.setViewportSize(
      layout === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1050 }
    );
    const headers = authHeaders();
    const projectResponse = await request.post("/api/v1/projects", {
      headers,
      data: {
        name: `Stage templates ${layout}`,
        repoRoot: `${repo}/${layout}`,
        color: "#336699",
      },
    });
    expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
    const project = await projectResponse.json();
    const board = await (
      await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
        headers,
      })
    ).json();
    const implementation = board.columns.find(
      (c: { key: string }) => c.key === "in_progress"
    );
    const review = board.columns.find(
      (c: { key: string }) => c.key === "in_review"
    );
    const makeTemplate = async (
      name: string,
      agentType: string,
      model: string
    ) => {
      const response = await request.post("/api/v1/templates", {
        headers,
        data: {
          name,
          projectId: project.id,
          directory: `${repo}/${layout}`,
          agentType,
          model,
          prompt: "Work on this task",
          useWorktree: false,
          fullAccess: false,
        },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const builder = await makeTemplate("Stage Builder", "claude", "sonnet");
    const lead = await makeTemplate("Stage Delivery Lead", "codex", "gpt-5.5");
    for (const column of [implementation, review]) {
      const response = await request.patch(
        `/api/v1/task-columns/${column.id}`,
        {
          headers,
          data: {
            trigger: {
              templateId: builder.id,
              agentType: "claude",
              model: "haiku",
              assign: false,
            },
          },
        }
      );
      expect(response.ok()).toBeTruthy();
    }
    try {
      await loadApp(page);
      await page.goto(`/tasks?project=${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      if (layout === "desktop") {
        await page
          .getByTestId("task-column-backlog")
          .getByRole("button", { name: "Add task" })
          .click();
      } else {
        await page.keyboard.press("Escape");
        await page
          .getByRole("main")
          .getByRole("button", { name: "New task", exact: true })
          .click();
      }
      const dialog = page.getByTestId("task-create-dialog");
      await dialog
        .getByLabel("Title", { exact: true })
        .fill(`Large task ${layout}`);
      await expect(
        dialog.getByRole("combobox", { name: "Launch stage", exact: true })
      ).toHaveText("In progress");
      await expect(
        dialog.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Use column default");
      await dialog
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Stage Delivery Lead", exact: true })
        .click();
      await expect(dialog.getByTestId("task-launch-preview")).toContainText(
        "codex · gpt-5.5"
      );
      await page.screenshot({
        path: `/tmp/dispatch-stage-template-${layout}-create.png`,
        scale: "device",
      });
      const createdResponse = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/v1/tasks"
      );
      await dialog
        .getByRole("button", { name: "Create task", exact: true })
        .click();
      const task = await (await createdResponse).json();
      expect(task.launchTemplates).toEqual({ [implementation.id]: lead.id });
      if (layout === "mobile")
        await page
          .getByTestId(`task-row-${task.id}`)
          .getByText(`Large task ${layout}`, { exact: true })
          .click();
      const detail = page.getByTestId("task-drawer");
      await expect(detail).toBeVisible();
      const read = async () =>
        (await request.get(`/api/v1/tasks/${task.id}`, { headers })).json();
      expect(
        (await read()).events.filter(
          (e: { kind: string }) => e.kind === "trigger_launched"
        )
      ).toHaveLength(0);
      // Read the later review stage without changing its choice.
      await detail
        .getByRole("combobox", { name: "Launch stage", exact: true })
        .click();
      await page
        .getByRole("option", { name: "In review", exact: true })
        .click();
      await expect(detail.getByTestId("task-launch-preview")).toContainText(
        "Column default"
      );
      await expect(detail.getByTestId("task-launch-preview")).toContainText(
        "claude · haiku"
      );
      await detail
        .getByRole("combobox", { name: "Launch stage", exact: true })
        .click();
      await page
        .getByRole("option", { name: "In progress", exact: true })
        .click();
      // Clear and save. Reload proves the persisted map is empty.
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Use column default", exact: true })
        .click();
      await detail
        .getByRole("button", { name: "Save launch template" })
        .click();
      await expect.poll(async () => (await read()).launchTemplates).toEqual({});
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        detail.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Use column default");
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Stage Delivery Lead", exact: true })
        .click();
      await detail
        .getByRole("button", { name: "Save launch template" })
        .click();
      await expect
        .poll(async () => (await read()).launchTemplates)
        .toEqual({ [implementation.id]: lead.id });
      expect(
        (await read()).events.filter(
          (e: { kind: string }) => e.kind === "trigger_launched"
        )
      ).toHaveLength(0);
      await page.screenshot({
        path: `/tmp/dispatch-stage-template-${layout}-detail.png`,
        scale: "device",
      });
      await detail
        .getByRole("combobox", {
          name: `Status for Large task ${layout}`,
          exact: true,
        })
        .click();
      await page
        .getByRole("option", { name: "In progress", exact: true })
        .click();
      const move = page.getByRole("dialog", {
        name: "Move and launch task template?",
      });
      await expect(move.getByTestId("task-launch-preview")).toContainText(
        "codex · gpt-5.5"
      );
      await page.screenshot({
        path: `/tmp/dispatch-stage-template-${layout}-launch.png`,
        scale: "device",
      });
      await move
        .getByRole("button", { name: "Move and launch", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await read()).events.filter(
              (e: { kind: string }) => e.kind === "trigger_launched"
            ).length
        )
        .toBe(1);
      const launched = (await read()).events.find(
        (e: { kind: string }) => e.kind === "trigger_launched"
      );
      trackAgent(launched.data.agentId);
      expect(launched.data).toMatchObject({
        source: "task",
        templateId: lead.id,
        configuration: { agentType: "codex", model: "gpt-5.5" },
      });
      expect((await read()).launchPreviews[review.id]).toMatchObject({
        source: "column",
        templateId: builder.id,
      });
      await request.delete(`/api/v1/templates/${lead.id}`, { headers });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(detail.getByTestId("task-launch-preview")).toContainText(
        "Unavailable:"
      );
      await page.screenshot({
        path: `/tmp/dispatch-stage-template-${layout}-unavailable.png`,
        scale: "device",
      });
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Use column default", exact: true })
        .click();
      await detail
        .getByRole("button", { name: "Save launch template" })
        .click();
      await expect.poll(async () => (await read()).launchTemplates).toEqual({});
    } finally {
      await cleanupE2EAgents(request);
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
    }
  });
}
