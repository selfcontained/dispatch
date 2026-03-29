import { test, expect } from "@playwright/test";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

test.describe("Activity range API", () => {
  test("stats endpoint accepts the shared range values", async ({ request }) => {
    for (const range of ["30d", "year", "all"]) {
      const res = await request.get(`/api/v1/activity/stats?range=${range}`, {
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

  test("daily-status endpoint returns matching granularity for each range", async ({ request }) => {
    const expected = {
      "7d": "day",
      "30d": "day",
      year: "month",
      all: "month",
    } as const;

    for (const [range, granularity] of Object.entries(expected)) {
      const res = await request.get(`/api/v1/activity/daily-status?range=${range}`, {
        headers: authHeader,
      });
      expect(res.ok()).toBeTruthy();

      const body = (await res.json()) as { days: unknown[]; granularity: string };
      expect(Array.isArray(body.days)).toBe(true);
      expect(body.granularity).toBe(granularity);
    }
  });
});
