import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, cleanupE2EAgents, loadApp, trackAgent } from "./helpers";

test.use({ deviceScaleFactor: 2 });

const repo = mkdtempSync(join(tmpdir(), "dispatch-task-templates-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

for (const layout of ["desktop", "mobile"] as const) {
  test(`task templates create, edit, clear and move directly on ${layout}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    mkdirSync(`${repo}/${layout}`, { recursive: true });
    await page.setViewportSize(
      layout === "mobile"
        ? { width: 390, height: 650 }
        : { width: 1440, height: 1050 }
    );
    const headers = authHeaders();
    const projectResponse = await request.post("/api/v1/projects", {
      headers,
      data: {
        name: `Task templates ${layout}`,
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
    const builder = await makeTemplate("Default Builder", "claude", "sonnet");
    const lead = await makeTemplate("Task Delivery Lead", "codex", "gpt-5.5");
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
      const assertContextBounds = async () => {
        const description = await dialog
          .getByLabel("Description", { exact: true })
          .boundingBox();
        const context = await dialog.getByTestId("task-context").boundingBox();
        const clipboard = await dialog
          .getByRole("button", { name: "Read clipboard", exact: true })
          .boundingBox();
        expect(description).not.toBeNull();
        expect(context).not.toBeNull();
        expect(clipboard).not.toBeNull();
        expect(description!.y + description!.height).toBeLessThanOrEqual(
          context!.y
        );
        expect(clipboard!.y).toBeGreaterThanOrEqual(context!.y);
        expect(clipboard!.y + clipboard!.height).toBeLessThanOrEqual(
          context!.y + context!.height
        );
      };
      await assertContextBounds();
      await dialog.getByLabel("Description", { exact: true }).focus();
      await assertContextBounds();
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-context.png`,
        scale: "device",
      });
      await dialog
        .getByLabel("Title", { exact: true })
        .fill(`Large task ${layout}`);
      await expect(
        dialog.getByRole("combobox", { name: "Launch stage", exact: true })
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Use column default");
      await dialog
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Task Delivery Lead", exact: true })
        .click();
      await expect(dialog.getByTestId("task-launch-preview")).toHaveCount(0);
      await expect(
        dialog.getByText(/Applies on the next eligible entry/)
      ).toHaveCount(0);
      // Radix removes the listbox before its close autofocus and pointer-event
      // cleanup finish. Wait for both before taking focus for keyboard checks.
      await expect(
        dialog.getByRole("combobox", { name: "Launch template", exact: true })
      ).toBeFocused();
      await expect(dialog).toHaveCSS("pointer-events", "auto");
      // Keyboard focus must leave room for the full four-pixel ring at every
      // scroll/overflow boundary, including when mobile needs to scroll.
      for (const [name, control] of [
        ["title", dialog.getByLabel("Title", { exact: true })],
        [
          "column",
          dialog.getByRole("combobox", { name: "Column", exact: true }),
        ],
        [
          "template",
          dialog.getByRole("combobox", {
            name: "Launch template",
            exact: true,
          }),
        ],
      ] as const) {
        // Start from a known control after the Select close/autofocus cycle,
        // then return via the keyboard so focus-visible is exercised.
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await control.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(control).toBeFocused();
        await expect
          .poll(() =>
            control.evaluate((el) => {
              const rect = el.getBoundingClientRect();
              for (
                let parent = el.parentElement;
                parent;
                parent = parent.parentElement
              ) {
                const style = getComputedStyle(parent);
                const bounds = parent.getBoundingClientRect();
                if (
                  /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
                  (rect.left - 4 < bounds.left || rect.right + 4 > bounds.right)
                )
                  return false;
                if (
                  /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
                  (rect.top - 4 < bounds.top || rect.bottom + 4 > bounds.bottom)
                )
                  return false;
              }
              return getComputedStyle(el).boxShadow !== "none";
            })
          )
          .toBe(true);
        await page.screenshot({
          path: `/tmp/dispatch-task-template-${layout}-focus-${name}.png`,
          scale: "device",
        });
      }
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-create.png`,
        scale: "device",
      });
      // A draft keeps its template choice when the creation destination changes.
      await dialog
        .getByRole("combobox", { name: "Column", exact: true })
        .click();
      await page
        .getByRole("option", { name: "In review", exact: true })
        .click();
      await expect(
        dialog.getByRole("combobox", { name: "Launch stage", exact: true })
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Task Delivery Lead");
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-visible-draft.png`,
        scale: "device",
      });
      await dialog
        .getByRole("combobox", { name: "Column", exact: true })
        .click();
      await page.getByRole("option", { name: "Backlog", exact: true }).click();
      const createdResponse = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/v1/tasks"
      );
      await dialog
        .getByRole("button", { name: "Create task", exact: true })
        .click();
      const task = await (await createdResponse).json();
      expect(task.launchTemplateId).toBe(lead.id);
      if (layout === "mobile")
        await page
          .getByTestId(`task-row-${task.id}`)
          .getByText(`Large task ${layout}`, { exact: true })
          .click();
      const detail = page.getByTestId("task-drawer");
      await expect(detail).toBeVisible();
      await expect(
        detail.getByText("Launch template", { exact: true })
      ).toHaveCount(1);
      await expect(
        detail.getByRole("combobox", { name: "Launch template", exact: true })
      ).toBeVisible();
      const read = async () =>
        (await request.get(`/api/v1/tasks/${task.id}`, { headers })).json();
      expect(
        (await read()).events.filter(
          (e: { kind: string }) => e.kind === "trigger_launched"
        )
      ).toHaveLength(0);
      // An external move must not hide an unsaved template draft.
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Default Builder", exact: true })
        .click();
      await request.patch(`/api/v1/tasks/${task.id}`, {
        headers,
        data: { columnId: review.id },
      });
      await expect(
        detail.getByRole("combobox", {
          name: `Status for Large task ${layout}`,
          exact: true,
        })
      ).toHaveText("In review");
      await expect(
        detail.getByRole("combobox", { name: "Launch stage", exact: true })
      ).toHaveCount(0);
      await expect(
        detail.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Default Builder");
      const reviewLaunch = (await read()).events.find(
        (e: { kind: string }) => e.kind === "trigger_launched"
      );
      trackAgent(reviewLaunch.data.agentId);
      const initialLaunchCount = 1;
      await request.patch(`/api/v1/tasks/${task.id}`, {
        headers,
        data: { columnId: task.columnId },
      });
      await expect(
        detail.getByRole("combobox", {
          name: `Status for Large task ${layout}`,
          exact: true,
        })
      ).toHaveText("Backlog");
      // Clear and save. Reload proves the persisted override is cleared.
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Use column default", exact: true })
        .click();
      await detail
        .getByRole("button", { name: "Save launch template" })
        .click();
      await expect.poll(async () => (await read()).launchTemplateId).toBeNull();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        detail.getByRole("combobox", { name: "Launch template", exact: true })
      ).toHaveText("Use column default");
      await detail
        .getByRole("combobox", { name: "Launch template", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Task Delivery Lead", exact: true })
        .click();
      await detail
        .getByRole("button", { name: "Save launch template" })
        .click();
      await expect
        .poll(async () => (await read()).launchTemplateId)
        .toBe(lead.id);
      expect(
        (await read()).events.filter(
          (e: { kind: string }) => e.kind === "trigger_launched"
        )
      ).toHaveLength(initialLaunchCount);
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-detail.png`,
        scale: "device",
      });
      const moveRequests: Record<string, unknown>[] = [];
      const previewRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/tasks/launch-preview"))
          previewRequests.push(request.url());
        if (
          request.method() === "PATCH" &&
          new URL(request.url()).pathname === `/api/v1/tasks/${task.id}`
        )
          moveRequests.push(request.postDataJSON());
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
      await expect
        .poll(
          async () =>
            (await read()).events.filter(
              (e: { kind: string }) => e.kind === "trigger_launched"
            ).length
        )
        .toBe(initialLaunchCount + 1);
      expect(moveRequests).toHaveLength(1);
      expect(moveRequests[0]).toMatchObject({ columnId: implementation.id });
      expect(moveRequests[0]).not.toHaveProperty("expectedLaunchRevision");
      expect(previewRequests).toHaveLength(0);
      await expect(
        page.getByRole("dialog", { name: "Move and launch task template?" })
      ).toHaveCount(0);
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-direct-move.png`,
        scale: "device",
      });
      const launched = (await read()).events.find(
        (e: { kind: string; data: { templateId: string } }) =>
          e.kind === "trigger_launched" && e.data.templateId === lead.id
      );
      trackAgent(launched.data.agentId);
      expect(launched.data).toMatchObject({
        source: "task",
        templateId: lead.id,
        configuration: { agentType: "codex", model: "gpt-5.5" },
      });
      await request.delete(`/api/v1/templates/${lead.id}`, { headers });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(detail.getByRole("alert")).toContainText(
        "Template unavailable. Choose another template or use the column default."
      );
      await page.screenshot({
        path: `/tmp/dispatch-task-template-${layout}-unavailable.png`,
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
      await expect.poll(async () => (await read()).launchTemplateId).toBeNull();
    } finally {
      await cleanupE2EAgents(request);
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
    }
  });
}
