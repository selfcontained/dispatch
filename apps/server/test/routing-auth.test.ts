import { RoutingSettings } from "../src/chat/routing-settings.js";
import { describe, expect, it, vi } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({
  setupAuth: false,
  env: { DISPATCH_DEV_STACK: "1", DISPATCH_DECISIONS_API_KEY: "" },
});

describe("routing settings authorization", () => {
  it("supports password-free dev settings without opening production or bypassing an existing password", async () => {
    const url = "/api/v1/experiments/routing/settings";
    expect((await ctx.app.inject({ url })).statusCode).toBe(200);
    const check = vi
      .spyOn(RoutingSettings.prototype, "check")
      .mockResolvedValue({ status: "ok", message: "verified" });
    const saved = await ctx.app.inject({
      method: "PUT",
      url,
      payload: { apiKey: "synthetic-dev-token", mode: "off" },
    });
    check.mockRestore();
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("synthetic-dev-token");
    vi.stubEnv("DISPATCH_DEV_STACK", "0");
    expect((await ctx.app.inject({ url })).statusCode).toBe(403);
    vi.stubEnv("DISPATCH_DEV_STACK", "1");
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password: "test-password-only" },
    });
    expect(setup.statusCode).toBe(200);
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          url,
          headers: { cookie: await ctx.sessionCookie() },
        })
      ).statusCode
    ).toBe(200);
    vi.unstubAllEnvs();
  });
});
