import { afterAll, describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({
  env: {
    DISPATCH_RUNNER_HOST: "127.0.0.1",
    DISPATCH_RUNNER_PORT: "0",
    DISPATCH_RUNNER_ENDPOINT_HOST: "127.0.0.1",
  },
});

afterAll(() => {
  delete process.env.DISPATCH_RUNNER_HOST;
  delete process.env.DISPATCH_RUNNER_PORT;
  delete process.env.DISPATCH_RUNNER_ENDPOINT_HOST;
});

describe("runner control API", () => {
  it("requires normal API authentication", async () => {
    for (const [method, url] of [
      ["GET", "/api/runners"],
      ["POST", "/api/runners"],
      ["DELETE", "/api/runners/rnr_x"],
      ["GET", "/api/v1/runners"],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        payload: method === "POST" ? { name: "a" } : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("creates, lists and revokes a registration", async () => {
    const cookie = await ctx.sessionCookie();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: "lima" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      command: string;
      expiresAt: string;
    };
    expect(Object.keys(body).sort()).toEqual(["command", "expiresAt", "id"]);
    expect(body.command).toContain("--endpoint https://127.0.0.1:");

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: " padded" },
    });
    expect(bad.statusCode).toBe(400);
    const duplicate = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: "lima" },
    });
    expect(duplicate.statusCode).toBe(409);

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/runners",
      headers: { cookie },
    });
    expect(listed.json()).toEqual({
      runners: [
        { id: body.id, name: "lima", status: "pending", workspaces: [] },
      ],
    });

    const renewal = await ctx.app.inject({
      method: "POST",
      url: `/api/runners/${body.id}/pair`,
      headers: { cookie },
    });
    expect(renewal.statusCode).toBe(201);
    expect(renewal.json().id).toBe(body.id);
    const unauthenticatedRenewal = await ctx.app.inject({
      method: "POST",
      url: `/api/runners/${body.id}/pair`,
    });
    expect(unauthenticatedRenewal.statusCode).toBe(401);

    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/runners/${body.id}`,
      headers: { cookie },
    });
    expect(revoked.json()).toEqual({ ok: true });
    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/runners",
      headers: { cookie },
    });
    expect(after.json().runners[0].status).toBe("revoked");
    const missing = await ctx.app.inject({
      method: "DELETE",
      url: "/api/runners/rnr_missing",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
