import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

function activityParams(opts: { daysBack?: number; granularity?: string } = {}): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const params = new URLSearchParams({ tz, granularity: opts.granularity ?? "day" });
  if (opts.daysBack !== undefined) {
    params.set("start", new Date(now.getTime() - opts.daysBack * 86400000).toISOString());
    params.set("end", now.toISOString());
  }
  return params.toString();
}

test.describe("Token usage API", () => {
  test("GET /api/v1/activity/token-stats returns zeroes when empty", async ({ request }) => {
    const res = await request.get("/api/v1/activity/token-stats", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as {
      total_input: number;
      total_cache_creation: number;
      total_cache_read: number;
      total_output: number;
      total_messages: number;
      total_sessions: number;
    };
    expect(body.total_input).toBe(0);
    expect(body.total_output).toBe(0);
    expect(body.total_sessions).toBe(0);
  });

  test("GET /api/v1/activity/token-daily returns empty days array when no data", async ({ request }) => {
    const res = await request.get(
      `/api/v1/activity/token-daily?${activityParams({ daysBack: 30, granularity: "day" })}`,
      { headers: authHeader }
    );
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { days: unknown[]; granularity: string };
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days.length).toBe(0);
    expect(body.granularity).toBe("day");
  });

  test("GET /api/v1/activity/token-by-project returns empty projects array when no data", async ({ request }) => {
    const res = await request.get("/api/v1/activity/token-by-project", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { projects: unknown[] };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBe(0);
  });

  test("POST /api/v1/agents/:id/harvest-tokens returns 404 for unknown agent", async ({ request }) => {
    const res = await request.post("/api/v1/agents/nonexistent-agent/harvest-tokens", {
      headers: authHeader,
    });
    expect(res.status()).toBe(404);
  });

  test("token endpoints accept start/end/tz params", async ({ request }) => {
    const daily7 = await request.get(
      `/api/v1/activity/token-daily?${activityParams({ daysBack: 7, granularity: "day" })}`,
      { headers: authHeader }
    );
    expect(daily7.ok()).toBeTruthy();
    expect(((await daily7.json()) as { granularity: string }).granularity).toBe("day");

    const daily30 = await request.get(
      `/api/v1/activity/token-daily?${activityParams({ daysBack: 30, granularity: "day" })}`,
      { headers: authHeader }
    );
    expect(daily30.ok()).toBeTruthy();
    expect(((await daily30.json()) as { granularity: string }).granularity).toBe("day");

    const dailyMonth = await request.get(
      `/api/v1/activity/token-daily?${activityParams({ granularity: "month" })}`,
      { headers: authHeader }
    );
    expect(dailyMonth.ok()).toBeTruthy();
    expect(((await dailyMonth.json()) as { granularity: string }).granularity).toBe("month");

    const totals = await request.get(
      `/api/v1/activity/token-stats?${activityParams({ granularity: "month" })}`,
      { headers: authHeader }
    );
    expect(totals.ok()).toBeTruthy();

    const byProject = await request.get(
      `/api/v1/activity/token-by-project?${activityParams()}`,
      { headers: authHeader }
    );
    expect(byProject.ok()).toBeTruthy();

    const byModel = await request.get(
      `/api/v1/activity/token-by-model?${activityParams({ daysBack: 30 })}`,
      { headers: authHeader }
    );
    expect(byModel.ok()).toBeTruthy();
  });
});

test.describe("Token usage UI", () => {
  test("Activity pane scopes requests when time range changes", async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/v1/activity/**", async (route) => {
      requests.push(route.request().url());
      await route.continue();
    });

    await loadApp(page);

    // Open the activity pane
    await page.getByTestId("activity-button").click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();

    // Heatmap should render
    await expect(page.getByText("Activity this year")).toBeVisible();

    await page.getByTestId("activity-range-select").click();
    await page.getByRole("option", { name: "This year" }).click();

    await expect(page.getByTestId("activity-range-select")).toContainText("This year");

    // After switching to "This year", requests should include tz and granularity params
    await expect.poll(
      () => requests.filter((url) => url.includes("tz=") && url.includes("granularity=")).length
    ).toBeGreaterThanOrEqual(6);

    // Close dialog
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Activity" })).not.toBeVisible();
  });
});
