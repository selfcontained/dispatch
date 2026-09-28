import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createAgentViaAPI, cleanupE2EAgents } from "./helpers";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

async function gotoMobile(page: Page, path: string): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.locator("main").waitFor({ state: "visible", timeout: 10_000 });
}

async function seedJob(request: APIRequestContext): Promise<void> {
  const dir = join(tmpdir(), `dispatch-e2e-mobile-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  await request.post("/api/v1/jobs", {
    headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    data: {
      name: "mobile-layout-e2e",
      directory: dir,
      prompt: "noop",
      schedule: "0 * * * *",
      timeoutMs: 120000,
      needsInputTimeoutMs: 86400000,
    },
  });
}

test.describe("Mobile layout", () => {
  test("tapping a job row on mobile closes the sidebar and reveals the detail pane", async ({
    page,
    request,
  }) => {
    await seedJob(request);
    await gotoMobile(page, "/jobs");

    await page.getByTitle("Open sidebar").click();
    const sidebar = page.getByRole("dialog", { name: "Navigation sidebar" });
    await expect(sidebar.getByTitle("Close sidebar")).toBeVisible();

    const firstRow = page.locator('[data-testid^="job-row-"]').first();
    await firstRow.waitFor({ state: "visible", timeout: 5_000 });
    await firstRow.click();

    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);

    // Mobile sidebar is a slide-over; it slides off to the left (x < 0) when closed.
    await expect
      .poll(
        async () =>
          sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().left)),
        { timeout: 2_000 }
      )
      .toBeLessThan(0);

    // The open-sidebar affordance is back once the detail is shown.
    await expect(page.getByTitle("Open sidebar")).toBeVisible();
  });

  test("activity history fills the viewport and scrolls", async ({ page }) => {
    await gotoMobile(page, "/activity/history");

    // Open-sidebar button should be rendered when the mobile sidebar is closed.
    await expect(page.getByTitle("Open sidebar")).toBeVisible();

    // The content wrapper inside <main> should fill most of the viewport.
    // Regression: the wrapper previously collapsed to ~300px because flex-1
    // was applied to a non-flex parent.
    const contentHeight = await page
      .locator("main > div")
      .last()
      .evaluate((el) => el.clientHeight);
    expect(contentHeight).toBeGreaterThan(MOBILE_VIEWPORT.height - 80);
  });

  test("settings detail exposes an open-sidebar button on mobile", async ({
    page,
  }) => {
    await gotoMobile(page, "/settings/general");

    const openButton = page.getByTitle("Open sidebar");
    await expect(openButton).toBeVisible();

    await openButton.click();
    const sidebar = page.getByRole("dialog", { name: "Navigation sidebar" });
    await expect(sidebar.getByTitle("Close sidebar")).toBeVisible();
    await expect
      .poll(async () =>
        sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().left))
      )
      .toBe(0);
  });
});

test("mobile composer expands on focus and preserves drafts when returning to reading", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  try {
    await gotoMobile(page, `/agents/${agent.id}`);
    const composer = page.getByTestId("chat-composer");
    const input = page.getByTestId("chat-composer-input");
    const attach = page.getByTestId("chat-composer-attach-button");
    await expect(input).toBeVisible();
    await expect(attach).toBeHidden();
    expect((await composer.boundingBox())!.height).toBeLessThan(60);
    await input.click();
    await expect(attach).toBeVisible();
    await input.pressSequentially("Keep this draft");
    await page.getByTestId("chat-filters-trigger").click();
    await expect(page.getByTestId("chat-filters-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(attach).toBeVisible();
    await expect(input).toHaveText("Keep this draft");
    await input.click();
    await input.press("ControlOrMeta+A");
    await input.press("Backspace");
    await page.getByTestId("chat-filters-trigger").click();
    await expect(page.getByTestId("chat-filters-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(attach).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(attach).toBeVisible();
  } finally {
    await cleanupE2EAgents(request);
  }
});
