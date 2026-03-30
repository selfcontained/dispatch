import { test, expect } from "@playwright/test";
import { loadApp, seedActivityDemoViaDB } from "./helpers";

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

test.describe("Activity range API", () => {
  test("stats endpoint accepts start/end/tz params", async ({ request }) => {
    const testCases = [
      { daysBack: 7, granularity: "day" },
      { daysBack: 30, granularity: "day" },
      { granularity: "month" }, // no start = all time
    ];
    for (const tc of testCases) {
      const res = await request.get(`/api/v1/activity/stats?${activityParams(tc)}`, {
        headers: authHeader,
      });
      expect(res.ok()).toBeTruthy();

      const body = (await res.json()) as {
        totalWorkingMs: number;
        avgBlockedMs: number;
        avgWaitingMs: number;
        busiestDay: string | null;
      };
      expect(typeof body.totalWorkingMs).toBe("number");
      expect(typeof body.avgBlockedMs).toBe("number");
      expect(typeof body.avgWaitingMs).toBe("number");
      expect(body.busiestDay === null || typeof body.busiestDay === "string").toBe(true);
    }
  });

  test("daily-status endpoint returns matching granularity", async ({ request }) => {
    const testCases = [
      { daysBack: 7, granularity: "day" },
      { daysBack: 30, granularity: "day" },
      { granularity: "month" },
    ] as const;

    for (const tc of testCases) {
      const res = await request.get(
        `/api/v1/activity/daily-status?${activityParams(tc)}`,
        { headers: authHeader }
      );
      expect(res.ok()).toBeTruthy();

      const body = (await res.json()) as { days: unknown[]; granularity: string };
      expect(Array.isArray(body.days)).toBe(true);
      expect(body.granularity).toBe(tc.granularity);
    }
  });

  test("active-hours endpoint returns events", async ({ request }) => {
    await seedActivityDemoViaDB();

    const res = await request.get(
      `/api/v1/activity/active-hours?${activityParams({ daysBack: 30 })}`,
      { headers: authHeader }
    );
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { events: Array<{ created_at: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((event) => typeof event.created_at === "string")).toBe(true);
  });
});

test.describe("Active hours UI", () => {
  test("activity pane renders the active-hours heatmap with seeded data", async ({ page }) => {
    await seedActivityDemoViaDB();
    await loadApp(page);

    await page.getByTestId("activity-button").click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await expect(page.getByText("Active hours")).toBeVisible();
    await expect(page.getByTestId("active-hours-cell-sample")).toBeVisible();

    await page.getByTestId("activity-range-select").click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect(page.getByText("Average active-state events per week by weekday and hour for last 30 days.")).toBeVisible();
  });
});
