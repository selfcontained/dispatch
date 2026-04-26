import { test, expect } from "@playwright/test";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

test.describe("API health", () => {
  test("GET /api/v1/health returns ok", async ({ request }) => {
    const res = await request.get("/api/v1/health");
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
  });

  test("GET /api/v1/agents returns an array", async ({ request }) => {
    const res = await request.get("/api/v1/agents", { headers: authHeader });
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { agents: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
