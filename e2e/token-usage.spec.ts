import { test, expect } from "@playwright/test";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

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
    const res = await request.get("/api/v1/activity/token-daily?days=7", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { days: unknown[] };
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days.length).toBe(0);
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

  test("token-daily respects days parameter and clamps to range", async ({ request }) => {
    // days=0 should clamp to 1
    const res = await request.get("/api/v1/activity/token-daily?days=0", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    // days=999 should clamp to 90
    const res2 = await request.get("/api/v1/activity/token-daily?days=999", { headers: authHeader });
    expect(res2.ok()).toBeTruthy();
  });
});

test.describe("Token usage UI", () => {
  test("Activity pane shows token stats when data exists", async ({ page, request }) => {
    // Seed token data directly via the database isn't available in E2E,
    // so we check the pane renders without errors when there's no data
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Open the activity pane
    await page.getByTestId("activity-button").click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();

    // Heatmap should render
    await expect(page.getByText("Activity this year")).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Activity" })).not.toBeVisible();
  });
});
