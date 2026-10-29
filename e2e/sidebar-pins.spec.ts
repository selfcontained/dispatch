import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  clickAgentRow,
  authHeaders,
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

const card = (page: Page, id: string) => page.getByTestId(`agent-card-${id}`);
const pinAction = (page: Page, id: string) =>
  page.getByTestId(`agent-pin-toggle-${id}`);
async function expand(page: Page, id: string) {
  if (!(await pinAction(page, id).isVisible())) {
    await page.getByTestId(`agent-expand-toggle-${id}`).click();
  }
  await expect(pinAction(page, id)).toBeVisible();
}
async function expectMobileSidebarOpen(page: Page) {
  const drawer = page.getByRole("dialog", { name: "Navigation sidebar" });
  await expect
    .poll(() =>
      drawer.evaluate((el) => Math.round(el.getBoundingClientRect().left))
    )
    .toBe(0);
}
async function visibleOrder(page: Page, ids: string[]) {
  return page
    .getByTestId("agent-sidebar")
    .locator('[data-testid^="agent-card-"]')
    .evaluateAll(
      (elements, wanted) =>
        elements
          .map((el) =>
            el.getAttribute("data-testid")!.replace("agent-card-", "")
          )
          .filter((id) => wanted.includes(id)),
      ids
    );
}

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

test("sidebar pins preserve normal order, keyboard movement, nested children and reload", async ({
  page,
  request,
}, testInfo) => {
  const a = await createAgentViaAPI(request, { name: "e2e-pin-a" });
  const b = await createAgentViaAPI(request, { name: "e2e-pin-b" });
  const c = await createAgentViaAPI(request, { name: "e2e-pin-c" });
  const child = await createAgentViaAPI(request, {
    name: "e2e-pin-child",
    parentAgentId: b.id,
  });
  const normal = [a.id, b.id, c.id];
  await loadApp(page);
  await page.evaluate(
    ({ normal, childId }) => {
      localStorage.setItem(
        "dispatch:agentSidebarOrder",
        JSON.stringify(normal)
      );
      localStorage.setItem(
        "dispatch:agentSidebarPins",
        JSON.stringify(["stale-id", "", childId, childId])
      );
    },
    { normal, childId: child.id }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card(page, a.id)).toBeVisible();
  await expect.poll(() => visibleOrder(page, normal)).toEqual(normal);
  await expect(card(page, child.id)).toHaveCount(0);
  await clickAgentRow(page, a.id);
  await expect(page).toHaveURL(new RegExp(`/agents/${a.id}`));
  const initialUrl = page.url();

  // Keyboard activation uses the native shadcn button and retains focus after reorder.
  await page.getByTestId(`agent-expand-toggle-${b.id}`).focus();
  await page.keyboard.press("Enter");
  await expect(pinAction(page, b.id)).toBeVisible();
  await pinAction(page, b.id).focus();
  await page.keyboard.press("Space");
  await expect(pinAction(page, b.id)).toBeFocused();
  await expect(pinAction(page, b.id)).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([b.id, a.id, c.id]);
  await expect(page.getByTestId(`child-agent-row-${child.id}`)).toBeVisible();
  await expect(page.getByTestId(`agent-pin-toggle-${child.id}`)).toHaveCount(0);
  expect(page.url()).toBe(initialUrl);
  await expect(card(page, a.id)).toHaveClass(/bg-muted\/60/);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("dispatch:agentSidebarOrder")!)
    )
  ).toEqual(normal);

  await expand(page, c.id);
  await pinAction(page, c.id).click();
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([b.id, c.id, a.id]);
  await page.getByTestId(`agent-expand-toggle-${c.id}`).click();
  await expect(page.getByTestId(`agent-pinned-${c.id}`)).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`agent-pinned-${b.id}`)).toBeVisible();
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([b.id, c.id, a.id]);

  // The unpinned group cannot move into the pinned group.
  await card(page, a.id).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([b.id, c.id, a.id]);
  await card(page, c.id).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([c.id, b.id, a.id]);
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(() => visibleOrder(page, normal))
    .toEqual([b.id, c.id, a.id]);

  await expand(page, b.id);
  await pinAction(page, b.id).click();
  await expand(page, c.id);
  await pinAction(page, c.id).click();
  await expect.poll(() => visibleOrder(page, normal)).toEqual(normal);
  expect(page.url()).toBe(initialUrl);
  await expect(card(page, a.id)).toHaveClass(/bg-muted\/60/);
  await testInfo.attach("desktop-pin-unpin", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test.describe("narrow touch sidebar pins", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("project filters retain hidden pins and touch pinning leaves the drawer open", async ({
    page,
    request,
  }, testInfo) => {
    const repo = mkdtempSync(join(tmpdir(), "dispatch-sidebar-pins-"));
    execFileSync("git", ["init", repo]);
    let projectId: string | undefined;
    try {
      const made = await request.post("/api/v1/projects", {
        headers: authHeaders(),
        data: { name: "Sidebar pin project", repoRoot: repo, color: "#9575ed" },
      });
      expect(made.ok()).toBeTruthy();
      projectId = (await made.json()).id;
      const scoped = await createAgentViaAPI(request, {
        name: "e2e-pin-scoped",
      });
      const other = await createAgentViaAPI(request, { name: "e2e-pin-other" });
      const assigned = await request.patch(
        `/api/v1/agents/${scoped.id}/project`,
        {
          headers: authHeaders(),
          data: { projectId },
        }
      );
      expect(assigned.ok()).toBeTruthy();
      await loadApp(page);
      const drawer = page.getByRole("dialog", { name: "Navigation sidebar" });
      await expectMobileSidebarOpen(page);
      await expand(page, other.id);
      await pinAction(page, other.id).tap();
      await expect(pinAction(page, other.id)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expectMobileSidebarOpen(page);
      await drawer.getByRole("button", { name: "Filter by project" }).tap();
      await page.getByRole("menuitem", { name: "Sidebar pin project" }).tap();
      await expect(card(page, other.id)).toHaveCount(0);
      await expand(page, scoped.id);
      await pinAction(page, scoped.id).tap();
      await expect(pinAction(page, scoped.id)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expectMobileSidebarOpen(page);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("dispatch:agentSidebarPins")!)
        )
      ).toEqual(expect.arrayContaining([scoped.id, other.id]));
      await drawer.getByRole("button", { name: "Filter by project" }).tap();
      await page.getByRole("menuitem", { name: "All projects" }).tap();
      await expect(page.getByTestId(`agent-pinned-${other.id}`)).toBeVisible();
      await expect(page.getByTestId(`agent-pinned-${scoped.id}`)).toBeVisible();
      await expectMobileSidebarOpen(page);
      await testInfo.attach("narrow-touch-project-pins", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    } finally {
      if (projectId)
        await request.delete(`/api/v1/projects/${projectId}`, {
          headers: authHeaders(),
        });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
