import { test, expect } from "@playwright/test";

test.describe("API health", () => {
  test("GET /api/v1/health returns ok", async ({ request }) => {
    const res = await request.get("/api/v1/health");
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
  });

  test("GET /api/v1/agents returns an array", async ({ request }) => {
    const res = await request.get("/api/v1/agents");
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { agents: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
  });

  test("POST /api/v1/agents validates cwd is required", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      data: { name: "missing-cwd" },
    });
    expect(res.status()).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cwd");
  });

  test("POST /api/v1/agents validates type", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      data: { cwd: "/tmp", type: "invalid-type" },
    });
    expect(res.status()).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("type");
  });
});
