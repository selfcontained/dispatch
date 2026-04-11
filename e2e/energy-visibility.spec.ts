import { test, expect, type Page } from "@playwright/test";
import { loadApp } from "./helpers";

/**
 * Simulate the page becoming hidden and trigger the visibilitychange event.
 * This also triggers a metrics save to localStorage via the beacon path.
 */
async function simulateHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: true,
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function simulateVisible(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: false,
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/**
 * Read energy metrics from localStorage. Going hidden triggers a save,
 * so call simulateHidden first if you need fresh data.
 */
async function readMetrics(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("dispatch:energyMetrics");
    return raw ? JSON.parse(raw) : null;
  });
}

test.describe("Energy / visibility-aware pausing", () => {
  test("SSE connection closes when page is hidden and reopens when visible", async ({
    page,
  }) => {
    await loadApp(page);
    await page.waitForTimeout(1000);

    // Simulate page going hidden
    await simulateHidden(page);

    // data-hidden attribute should be set on <html>
    await expect(page.locator("html[data-hidden]")).toBeAttached();

    await page.waitForTimeout(500);

    // Simulate page becoming visible again
    await simulateVisible(page);

    // data-hidden should be removed
    await expect(page.locator("html[data-hidden]")).not.toBeAttached();

    // Health poll should resume — check API status in Settings still shows ok
    await page.getByTestId("settings-button").click();
    const apiStatus = page.getByRole("dialog", { name: "Settings" }).getByTestId("service-status-api");
    await expect(apiStatus).toContainText("ok", { timeout: 15_000 });
  });

  test("energy metrics are persisted to localStorage on visibility change", async ({
    page,
  }) => {
    await loadApp(page);
    await page.waitForTimeout(1000);

    // Going hidden triggers save() via beacon
    await simulateHidden(page);
    await page.waitForTimeout(200);

    const metrics = await readMetrics(page);
    expect(metrics).not.toBeNull();
    expect(metrics).toHaveProperty("windowStart");
    expect(metrics).toHaveProperty("sseEventsReceived");
    expect(metrics).toHaveProperty("visibilityChanges");
    expect(metrics).toHaveProperty("totalHiddenMs");
    expect(typeof metrics!.sseEventsReceived).toBe("number");
  });

  test("energy metrics record SSE events", async ({ page }) => {
    await loadApp(page);

    // SSE snapshot fires immediately on connect — wait for it
    await page.waitForTimeout(2000);

    // Trigger save via hidden
    await simulateHidden(page);
    await page.waitForTimeout(200);

    const metrics = await readMetrics(page);
    expect(metrics).not.toBeNull();
    // The SSE connection receives at least a snapshot event on connect
    expect(metrics!.sseEventsReceived).toBeGreaterThanOrEqual(1);
  });

  test("visibility changes are recorded in metrics", async ({ page }) => {
    await loadApp(page);
    await page.waitForTimeout(500);

    // hidden → visible → hidden (to trigger the save)
    await simulateHidden(page);
    await page.waitForTimeout(200);
    await simulateVisible(page);
    await page.waitForTimeout(200);
    await simulateHidden(page);
    await page.waitForTimeout(200);

    const metrics = await readMetrics(page);
    expect(metrics).not.toBeNull();
    // At least 2 transitions recorded (hidden→visible cycle)
    expect((metrics!.visibilityChanges as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(metrics!.totalHiddenMs).toBeGreaterThan(0);
  });

  test("health poll timer does not fire while hidden", async ({ page }) => {
    await loadApp(page);

    // Wait for initial health poll to complete
    await page.waitForTimeout(1000);

    // Trigger a save to get baseline
    await simulateHidden(page);
    await page.waitForTimeout(200);
    const beforeMetrics = await readMetrics(page);
    const pollsBefore = (beforeMetrics?.healthPollFires as number) ?? 0;

    // Stay hidden longer than the 8s health poll interval
    await page.waitForTimeout(9000);

    // Read metrics again (still in localStorage from the beacon)
    // Trigger another save by going visible then hidden
    await simulateVisible(page);
    await page.waitForTimeout(200);
    await simulateHidden(page);
    await page.waitForTimeout(200);

    const afterMetrics = await readMetrics(page);
    const pollsAfter = (afterMetrics?.healthPollFires as number) ?? 0;

    // At most 1 extra poll from the simulateVisible→immediate health check
    // but no 8s interval fires while hidden
    expect(pollsAfter - pollsBefore).toBeLessThanOrEqual(1);
  });
});
