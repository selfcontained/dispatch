import { test, expect } from "@playwright/test";
import { createAgentViaAPI } from "./helpers";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

test.describe("Focus tracking API", () => {
  test("POST /api/v1/focus accepts a valid agentId", async ({ request }) => {
    const agent = await createAgentViaAPI(request);
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: agent.id },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/focus accepts null agentId", async ({ request }) => {
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: null },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/focus accepts missing agentId (treated as null)", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: {},
    });
    expect(res.status()).toBe(204);
  });
});
