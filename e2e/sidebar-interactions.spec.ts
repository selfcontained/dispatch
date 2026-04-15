import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

const AUTH_HEADERS = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
  "Content-Type": "application/json",
};

async function expectMobileSidebarOpen(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Agent sidebar" });
  await expect(dialog.getByTitle("Close sidebar")).toBeVisible();
  await expect
    .poll(async () => dialog.evaluate((el) => Math.round(el.getBoundingClientRect().left)))
    .toBe(0);
}

async function createJobViaAPI(request: import("@playwright/test").APIRequestContext, name: string, directory: string) {
  const res = await request.post("/api/v1/jobs", {
    headers: AUTH_HEADERS,
    data: {
      name,
      directory,
      prompt: `Mobile sidebar test job ${name}.`,
      schedule: "* * * * *",
      timeoutMs: 120000,
      needsInputTimeoutMs: 86400000,
    },
  });

  expect(res.ok(), `Failed to create job ${name}: ${await res.text()}`).toBeTruthy();
  return res.json() as Promise<{ id: string; name: string }>;
}

test.describe("Sidebar interactions", () => {
  test("closing and reopening the left sidebar", async ({ page }) => {
    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar).toBeVisible();

    // Close the sidebar using the chevron button inside it
    await sidebar.getByTitle("Close sidebar").click();

    // The sidebar wrapper collapses to width:0 with overflow:hidden.
    // Wait for the CSS transition to finish, then verify the wrapper has zero width.
    await page.waitForTimeout(400);
    const wrapper = sidebar.locator("..");
    const width = await wrapper.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThan(4);

    // Reopen using the header button
    await page.getByTitle("Open agent sidebar").click();

    // Create button should be visible again after the sidebar expands
    await expect(page.getByTestId("create-agent-button")).toBeVisible({ timeout: 3_000 });
  });

  test("Create button opens the create agent dialog", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();

    await expect(page.getByTestId("create-agent-form")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Create Agent")).toBeVisible();
  });

  test("mobile navigation back to agents opens the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadApp(page);

    await page.getByTitle("Open agent sidebar").click();
    await expectMobileSidebarOpen(page);
    await page.getByTestId("jobs-button").click();
    await expect(page).toHaveURL(/\/jobs$/);

    await page.getByTestId("agents-button").click();
    await expect(page).toHaveURL(/\/$/);
    await expectMobileSidebarOpen(page);
  });

  test("mobile jobs list does not show selected band after leaving job detail", async ({ page, request }) => {
    const job = await createJobViaAPI(
      request,
      `e2e-mobile-job-${Date.now()}`,
      `/tmp/e2e-mobile-job-${Date.now()}`
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await loadApp(page);

    await page.getByTitle("Open agent sidebar").click();
    await expectMobileSidebarOpen(page);
    await page.getByTestId("jobs-button").click();
    await expect(page).toHaveURL(/\/jobs$/);

    const jobRow = page.getByTestId(`job-row-${job.id}`);
    await expect(jobRow).toBeVisible();
    await jobRow.click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`));

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(jobRow).toBeVisible();

    const styles = await jobRow.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return {
        backgroundColor: computed.backgroundColor,
        borderRightColor: computed.borderRightColor,
      };
    });

    expect(styles.borderRightColor).toBe("rgba(0, 0, 0, 0)");
    expect(styles.backgroundColor).not.toBe("rgba(32, 35, 39, 0.6)");
  });
});
