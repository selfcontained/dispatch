import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { loadApp } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

async function seedTokenUsage(
  rows: Array<{
    agent_id: string;
    session_id: string;
    model: string;
    input_tokens: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    output_tokens: number;
    message_count?: number;
  }>
): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    for (const row of rows) {
      await client.query(
        `INSERT INTO agents (id, name, type, cwd, status) VALUES ($1, $1, 'claude', '/tmp', 'done')
         ON CONFLICT (id) DO NOTHING`,
        [row.agent_id]
      );
      await client.query(
        `INSERT INTO agent_token_usage
          (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, message_count, session_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (agent_id, session_id, model) DO UPDATE SET
          input_tokens = EXCLUDED.input_tokens,
          cache_creation_tokens = EXCLUDED.cache_creation_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          output_tokens = EXCLUDED.output_tokens,
          message_count = EXCLUDED.message_count`,
        [
          row.agent_id, row.session_id, row.model,
          row.input_tokens, row.cache_creation_tokens ?? 0,
          row.cache_read_tokens ?? 0, row.output_tokens,
          row.message_count ?? 1,
        ]
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function cleanupTokenUsage(agentIdPrefix: string): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(`DELETE FROM agent_token_usage WHERE agent_id LIKE $1`, [`${agentIdPrefix}%`]);
    await pool.query(`DELETE FROM agents WHERE id LIKE $1`, [`${agentIdPrefix}%`]);
  } finally {
    await pool.end();
  }
}

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

test.describe("Token stats with seeded data", () => {
  const AGENT_PREFIX = "e2e-token-stats-";

  test.afterAll(async () => {
    await cleanupTokenUsage(AGENT_PREFIX);
  });

  test("token-stats returns correct totals for seeded data", async ({ request }) => {
    await seedTokenUsage([
      {
        agent_id: `${AGENT_PREFIX}a1`,
        session_id: "sess-1",
        model: "claude-opus-4-6",
        input_tokens: 500_000,
        cache_creation_tokens: 100_000,
        cache_read_tokens: 200_000,
        output_tokens: 50_000,
        message_count: 10,
      },
      {
        agent_id: `${AGENT_PREFIX}a1`,
        session_id: "sess-2",
        model: "claude-opus-4-6",
        input_tokens: 300_000,
        output_tokens: 30_000,
        message_count: 5,
      },
    ]);

    const res = await request.get("/api/v1/activity/token-stats", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.total_input).toBeGreaterThanOrEqual(800_000);
    expect(body.total_cache_creation).toBeGreaterThanOrEqual(100_000);
    expect(body.total_cache_read).toBeGreaterThanOrEqual(200_000);
    expect(body.total_output).toBeGreaterThanOrEqual(80_000);
    expect(body.total_messages).toBeGreaterThanOrEqual(15);
    expect(body.total_sessions).toBeGreaterThanOrEqual(2);

    // All values must be numbers, not strings (bigint parser check)
    for (const key of ["total_input", "total_cache_creation", "total_cache_read", "total_output", "total_messages", "total_sessions"]) {
      expect(typeof body[key]).toBe("number");
    }

    await cleanupTokenUsage(AGENT_PREFIX);
  });

  test("token-stats handles values exceeding int32 max without error", async ({ request }) => {
    // Insert rows that would overflow a 32-bit int when summed (~2.15B each)
    await seedTokenUsage([
      {
        agent_id: `${AGENT_PREFIX}overflow-1`,
        session_id: "sess-big-1",
        model: "claude-opus-4-6",
        input_tokens: 1_500_000_000,
        output_tokens: 500_000_000,
      },
      {
        agent_id: `${AGENT_PREFIX}overflow-2`,
        session_id: "sess-big-2",
        model: "claude-opus-4-6",
        input_tokens: 1_500_000_000,
        output_tokens: 500_000_000,
      },
    ]);

    const res = await request.get("/api/v1/activity/token-stats", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    // Sum of input_tokens = 3B, exceeds int32 max (2,147,483,647)
    expect(body.total_input).toBeGreaterThanOrEqual(3_000_000_000);
    expect(body.total_output).toBeGreaterThanOrEqual(1_000_000_000);
    expect(typeof body.total_input).toBe("number");
    expect(typeof body.total_output).toBe("number");

    await cleanupTokenUsage(AGENT_PREFIX);
  });
});
