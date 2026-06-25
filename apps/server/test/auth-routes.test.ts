import { describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

// ---------------------------------------------------------------------------
// GET /api/v1/auth/status
// ---------------------------------------------------------------------------
describe("GET /api/v1/auth/status", () => {
  it("returns passwordSet=true and authenticated=false without cookie", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().passwordSet).toBe(true);
    expect(res.json().authenticated).toBe(false);
  });

  it("returns authenticated=true with valid session cookie", async () => {
    const loginRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "hunter2hunter2" },
    });
    const cookie = loginRes.headers["set-cookie"] as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(true);
    expect(res.json().passwordSet).toBe(true);
  });

  it("returns authenticated=false with invalid cookie", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers: { cookie: "dispatch_session=s:bogus.invalidsig" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/setup
// ---------------------------------------------------------------------------
describe("POST /api/v1/auth/setup", () => {
  it("rejects when password is already set", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password: "anotherpass1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already set/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------
describe("POST /api/v1/auth/login", () => {
  it("rejects missing password", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects empty password", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects incorrect password", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "wrongpassword" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/invalid password/i);
  });

  it("succeeds with correct password and returns session cookie", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "hunter2hunter2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.headers["set-cookie"]).toBeTruthy();
    const cookie = res.headers["set-cookie"] as string;
    expect(cookie).toMatch(/dispatch_session=/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------
describe("POST /api/v1/auth/logout", () => {
  it("invalidates session and clears cookie", async () => {
    const cookie = await ctx.sessionCookie();

    const logoutRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().ok).toBe(true);

    const statusRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers: { cookie },
    });
    expect(statusRes.json().authenticated).toBe(false);
  });

  it("succeeds without a session cookie", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/change-password
// ---------------------------------------------------------------------------
describe("POST /api/v1/auth/change-password", () => {
  it("rejects missing fields", async () => {
    const cookie = await ctx.sessionCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects short new password", async () => {
    const cookie = await ctx.sessionCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "hunter2hunter2",
        newPassword: "short",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects wrong current password", async () => {
    const cookie = await ctx.sessionCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "wrongpassword",
        newPassword: "newpass12345",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/incorrect/i);
  });

  it("succeeds with correct current password and issues new session", async () => {
    const cookie = await ctx.sessionCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "hunter2hunter2",
        newPassword: "newpass123456",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.headers["set-cookie"]).toBeTruthy();

    const statusRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers: { cookie },
    });
    expect(statusRes.json().authenticated).toBe(false);
  });
});
