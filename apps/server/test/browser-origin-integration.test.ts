import { expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({ setupAuth: false });

it("protects multipart agent launch before password setup and with a session cookie", async () => {
  const payload =
    '--boundary\r\nContent-Disposition: form-data; name="cwd"\r\n\r\n/tmp\r\n--boundary--\r\n';
  for (const passwordSet of [false, true]) {
    if (passwordSet) {
      const setup = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        headers: { origin: "http://localhost" },
        payload: { password: "test-password-for-origin" },
      });
      expect(setup.statusCode).toBe(200);
    }
    const cookie = passwordSet ? await ctx.sessionCookie() : undefined;
    const good = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { origin: "http://localhost", ...(cookie ? { cookie } : {}) },
      payload: {},
    });
    expect(good.statusCode).toBe(400);
    expect(good.json().error).toContain("cwd");
    for (const url of ["/api/v1/agents", "/%61pi/v1/agents"]) {
      const res = await ctx.app.inject({
        method: "POST",
        url,
        headers: {
          origin: "http://evil.example",
          "content-type": "multipart/form-data; boundary=boundary",
          ...(cookie ? { cookie } : {}),
        },
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("UNTRUSTED_ORIGIN");
    }
  }
  expect((await ctx.pool.query("SELECT id FROM agents")).rows).toHaveLength(0);
});

it("rejects cross-origin password setup", async () => {
  const bad = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    headers: { origin: "http://evil.example" },
    payload: { password: "attacker-password" },
  });
  expect(bad.statusCode).toBe(403);
});
