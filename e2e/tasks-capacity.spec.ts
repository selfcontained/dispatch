import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { authHeaders, loadApp } from "./helpers";

const repo = mkdtempSync(join(tmpdir(), "dispatch-capacity-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

for (const mobile of [false, true]) {
  test.describe(mobile ? "mobile capacity" : "desktop capacity", () => {
    test.use({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
    });
    test("sets a limit, explains refusals, and admits after removal", async ({
      page,
      request,
    }, testInfo) => {
      const headers = authHeaders();
      const projectResponse = await request.post("/api/v1/projects", {
        headers,
        data: {
          name: `Capacity ${mobile ? "mobile" : "desktop"}`,
          repoRoot: repo,
        },
      });
      expect(projectResponse.ok()).toBeTruthy();
      const project = await projectResponse.json();
      const layout = mobile ? "list" : "board";
      const navigate = async (suffix = "") => {
        await page.goto(
          `/tasks?project=${project.id}&layout=${layout}${suffix}`,
          { waitUntil: "domcontentloaded" }
        );
      };
      try {
        const board = await (
          await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
            headers,
          })
        ).json();
        const ready = board.columns.find(
          (column: { key: string }) => column.key === "ready"
        );
        const backlog = board.columns.find(
          (column: { key: string }) => column.key === "backlog"
        );
        const create = async (title: string, columnId: string) => {
          const response = await request.post("/api/v1/tasks", {
            headers,
            data: { projectId: project.id, title, columnId },
          });
          expect(response.ok(), await response.text()).toBeTruthy();
          return await response.json();
        };
        const archived = await create("Archived occupant", ready.id);
        expect(
          (
            await request.post(`/api/v1/tasks/${archived.id}/archive`, {
              headers,
            })
          ).ok()
        ).toBeTruthy();
        await create("Current occupant", ready.id);
        const entrant = await create("Waiting task", backlog.id);
        await loadApp(page);
        await navigate();
        const surface = page.getByTestId(mobile ? "tasks-list" : "tasks-board");
        const occupancy = surface.getByTestId("column-capacity-ready");
        const openCapacity = async (label: string) => {
          await surface.getByRole("button", { name: "Ready menu" }).click();
          await page.getByRole("menuitem", { name: label }).click();
          return page.getByRole("dialog", { name: "Capacity · Ready" });
        };
        let dialog = await openCapacity("Set capacity…");
        await dialog
          .getByRole("spinbutton", { name: "Active task limit" })
          .fill("1");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(occupancy).toHaveText("1 / 1Full");
        await page
          .getByRole("textbox", { name: "Search tasks" })
          .fill("Waiting task");
        await expect(occupancy).toHaveText("1 / 1Full");
        await page.getByRole("textbox", { name: "Search tasks" }).fill("");
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(occupancy).toHaveText("1 / 1Full");
        const move = async (target: string) =>
          moveTask(page, entrant.id, mobile, target);
        await move("Ready");
        const refusal = page.getByRole("dialog", {
          name: "Could not move task",
        });
        await expect(refusal).toContainText(/Ready/);
        await expect(refusal).toContainText(/capacity|limit|full/i);
        await expect(
          page.getByRole("button", { name: "Move and launch" })
        ).toHaveCount(0);
        const screenshot = join(
          tmpdir(),
          `dispatch-capacity-${mobile ? "mobile" : "desktop"}-refused.png`
        );
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach("capacity refusal", {
          path: screenshot,
          contentType: "image/png",
        });
        await refusal
          .getByRole("button", { name: "Close", exact: true })
          .click();
        const unchanged = await (
          await request.get(`/api/v1/tasks/${entrant.id}`, { headers })
        ).json();
        expect((unchanged.task ?? unchanged).columnId).toBe(backlog.id);

        // Archived view uses active occupancy; a failed restore remains archived.
        await navigate("&view=archived");
        await expect(
          page.getByRole("heading", { name: "Archived tasks" })
        ).toBeVisible();
        await expect(
          page.getByTestId("column-capacity-ready").last()
        ).toHaveText("1 / 1Full");
        await page
          .getByRole("button", { name: "Restore", exact: true })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          /capacity|limit|full/i
        );
        await expect(
          page.getByRole("button", { name: "Archived occupant", exact: true })
        ).toBeVisible();

        await navigate();
        dialog = await openCapacity("Edit capacity…");
        await dialog.getByRole("button", { name: "Remove limit" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(occupancy).toHaveText("1");
        await move("Ready");
        await expect(occupancy).toHaveText("2");
        await expect(
          page.getByRole("dialog", { name: "Could not move task" })
        ).toHaveCount(0);
        // Lowering capacity never evicts tasks; it shows the existing overage.
        dialog = await openCapacity("Set capacity…");
        await dialog
          .getByRole("spinbutton", { name: "Active task limit" })
          .fill("1");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(occupancy).toHaveText("2 / 1Over limit");
        const allowedScreenshot = join(
          tmpdir(),
          `dispatch-capacity-${mobile ? "mobile" : "desktop"}-allowed.png`
        );
        await page.screenshot({ path: allowedScreenshot, fullPage: true });
        await testInfo.attach("admitted move and lowered limit", {
          path: allowedScreenshot,
          contentType: "image/png",
        });
      } finally {
        await request.delete(`/api/v1/projects/${project.id}`, { headers });
      }
    });
  });
}

async function moveTask(
  page: Page,
  taskId: string,
  mobile: boolean,
  target: string
) {
  if (mobile) {
    await page
      .getByTestId(`task-row-${taskId}`)
      .getByRole("combobox", { name: "Status for Waiting task" })
      .last()
      .click();
    await page.getByRole("option", { name: target, exact: true }).click();
  } else {
    await page
      .getByTestId(`task-card-${taskId}`)
      .getByRole("button", { name: "Waiting task actions" })
      .click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page
      .getByTestId("task-move-sheet")
      .getByRole("button", { name: target, exact: true })
      .click();
  }
}
