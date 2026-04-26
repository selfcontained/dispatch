import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

async function seedTerminalAgent(
  request: APIRequestContext
): Promise<{ id: string }> {
  const res = await request.post("/api/v1/agents", {
    headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    data: {
      name: `mobile-toolbar-${Date.now()}`,
      type: "terminal",
      cwd: "/tmp",
      useWorktree: false,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { agent: { id: string } };
  return { id: body.agent.id };
}

test.describe("Mobile layout", () => {
  test("terminal mobile toolbar only flashes connected shortcut buttons", async ({
    page,
    request,
  }) => {
    await gotoMobile(page, "/agents");

    const disconnectedEnterButton = page.getByLabel("Send Enter");
    const disconnectedInputButton = page.getByLabel("Open text input");
    const ctrlButton = page.getByLabel("Toggle Control modifier");

    await expect(disconnectedEnterButton).toBeDisabled();
    await expect(disconnectedInputButton).toBeDisabled();
    await expect(ctrlButton).toBeDisabled();
    await expect(page.getByTestId("toolbar-flash-enter")).toHaveCount(0);

    const { id } = await seedTerminalAgent(request);
    await gotoMobile(page, `/agents/${id}`);

    const enterButton = page.getByLabel("Send Enter");

    await enterButton.click();
    await expect(page.getByTestId("toolbar-flash-enter")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("toolbar-flash-enter")).toHaveCount(0);

    await ctrlButton.click();
    await expect(ctrlButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("toolbar-flash-ctrl")).toHaveCount(0);
  });

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
