import { describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({ setupAuth: false });

describe("engine updates use normal Dispatch authentication", () => {
  it("allows passwordless access and requires authentication after password setup", async () => {
    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/engines",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().canManage).toBe(true);
    // An unsupported ID proves access reaches validation without running any CLI.
    const open = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/engines/not-an-engine/update",
    });
    expect(open.statusCode).toBe(400);

    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password: "hunter2hunter2" },
    });
    expect(setup.statusCode).toBe(200);
    const denied = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/engines/not-an-engine/update",
    });
    expect(denied.statusCode).toBe(401);

    const headers = { cookie: await ctx.sessionCookie() };
    const authenticated = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/engines",
      headers,
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().canManage).toBe(true);
    const allowed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/engines/not-an-engine/update",
      headers,
    });
    expect(allowed.statusCode).toBe(400);
    const bearer = {
      authorization: `Bearer ${await ctx.auth.getOrCreateAuthToken(ctx.pool)}`,
    };
    const apiAccess = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/engines",
      headers: bearer,
    });
    expect(apiAccess.statusCode).toBe(200);
    expect(apiAccess.json().canManage).toBe(true);
  });
});
