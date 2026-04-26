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

test.describe("Mobile layout", () => {
  test("design lab previews silent-mode enter feedback concepts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/design-lab", { waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "visible", timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: "Mobile Enter feedback studies" })
    ).toBeVisible();

    const haloEnter = page.getByTestId("enter-feedback-halo");
    const haloCount = page.getByTestId("feedback-count-halo");

    await expect(haloCount).toContainText("0 preview taps");
    await haloEnter.click();
    await expect(haloCount).toContainText("1 preview taps");

    await expect(page.getByRole("button", { name: "Esc" })).toHaveCount(0);

    await expect
      .poll(async () => {
        const box = await haloEnter.boundingBox();
        return box ? Math.round(box.x + box.width) : null;
      })
      .toBeLessThanOrEqual(320);

    await expect(page.getByTestId("enter-feedback-sweep")).toBeVisible();
    await expect(page.getByTestId("enter-feedback-chip")).toBeVisible();
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
