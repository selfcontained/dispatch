import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerBrowserOriginProtection } from "../src/browser-origin.js";

const apps: ReturnType<typeof Fastify>[] = [];
function buildApp(origins?: string) {
  const app = Fastify();
  apps.push(app);
  registerBrowserOriginProtection(app, origins);
  app.post("/api/write", async () => ({ ok: true }));
  app.get("/api/read", async () => ({ ok: true }));
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("browser origin protection", () => {
  it.each(["/%61pi/write", "/a%70i/write", "/%61%70%69/write?x=1"])(
    "protects the matched API route for encoded path %s",
    async (url) => {
      const app = buildApp();
      const hostile = await app.inject({
        method: "POST",
        url,
        headers: { origin: "https://evil.example" },
      });
      expect(hostile.statusCode).toBe(403);
      expect(hostile.json().code).toBe("UNTRUSTED_ORIGIN");
      const sameOrigin = await app.inject({
        method: "POST",
        url,
        headers: { origin: "http://localhost" },
      });
      expect(sameOrigin.statusCode).toBe(200);
    }
  );

  it.each([
    { host: "localhost:4567", origin: "http://localhost:4567" },
    { host: "192.168.1.20:4567", origin: "http://192.168.1.20:4567" },
    { host: "[::1]:4567", origin: "http://[::1]:4567" },
    { host: "localhost:80", origin: "http://localhost" },
    { host: "localhost", referer: "http://localhost/agents" },
    { host: "localhost", "sec-fetch-site": "same-origin" },
    { host: "localhost" },
  ])(
    "accepts same-origin browser writes and non-browser clients: %j",
    async (headers) => {
      const res = await buildApp().inject({
        method: "POST",
        url: "/api/write",
        headers,
      });
      expect(res.statusCode).toBe(200);
    }
  );

  it.each([
    { origin: "http://evil.example" },
    { origin: "null" },
    { origin: "not a URL" },
    { origin: "http://localhost/forged" },
    { origin: "http://localhost:9999" },
    { origin: "https://localhost" },
    { referer: "http://evil.example/form" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "http://evil.example", authorization: "Bearer invalid" },
    { origin: "http://evil.example", "x-forwarded-host": "evil.example" },
  ])(
    "rejects untrusted writes even without password auth: %j",
    async (headers) => {
      const res = await buildApp().inject({
        method: "POST",
        url: "/api/write",
        headers: { host: "localhost", ...headers },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("UNTRUSTED_ORIGIN");
    }
  );

  it("allows an explicitly configured proxy origin without trusting forwarded headers", async () => {
    const app = buildApp("https://dispatch.example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/write",
      headers: {
        host: "127.0.0.1:6767",
        origin: "https://dispatch.example.com",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    "*",
    "https://example.com/",
    "null",
    "https://user:pass@example.com",
  ])("rejects invalid trusted-origin configuration %s", (value) => {
    expect(() => buildApp(value)).toThrow("DISPATCH_ALLOWED_ORIGINS");
  });

  it("does not restrict reads", async () => {
    const res = await buildApp().inject({
      method: "GET",
      url: "/api/read",
      headers: { origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves extension bearer authorization to its mandatory route guard", async () => {
    const app = buildApp();
    app.post(
      "/api/extension",
      {
        config: { browserExtensionBearer: true },
        preHandler: async (_req, reply) =>
          reply.code(401).send({ error: "Token required" }),
      },
      async () => ({ ok: true })
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/extension",
      headers: { origin: "chrome-extension://test" },
    });
    expect(res.statusCode).toBe(401);
  });
});
