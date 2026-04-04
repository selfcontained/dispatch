import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";

/**
 * Integration tests for rate limiting configuration.
 *
 * These verify the @fastify/rate-limit config applied to auth endpoints
 * in server.ts. Each test group gets a fresh Fastify instance so rate
 * limit counters don't bleed between tests.
 */

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyRateLimit, { global: false });

  // Mirror the rate-limit config from server.ts
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async () => ({ ok: true }),
  );

  app.post(
    "/api/v1/auth/setup",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async () => ({ ok: true }),
  );

  app.get("/api/v1/auth/status", async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe("rate limiting", () => {
  describe("login endpoint", () => {
    let app: FastifyInstance;

    beforeAll(async () => { app = await buildApp(); });
    afterAll(async () => { await app.close(); });

    it("allows 5 attempts then returns 429", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: "POST", url: "/api/v1/auth/login" });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: "POST", url: "/api/v1/auth/login" });
      expect(blocked.statusCode).toBe(429);
    });

    it("includes rate limit headers", async () => {
      // First request already consumed above, but headers are present on every response.
      // The 429 response from the previous test still counts — just verify headers exist.
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login" });
      expect(res.headers["x-ratelimit-limit"]).toBe("5");
    });
  });

  describe("setup endpoint", () => {
    let app: FastifyInstance;

    beforeAll(async () => { app = await buildApp(); });
    afterAll(async () => { await app.close(); });

    it("allows 3 attempts then returns 429", async () => {
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: "POST", url: "/api/v1/auth/setup" });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: "POST", url: "/api/v1/auth/setup" });
      expect(blocked.statusCode).toBe(429);
    });

    it("429 response includes retry-after header", async () => {
      const blocked = await app.inject({ method: "POST", url: "/api/v1/auth/setup" });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
    });
  });

  describe("status endpoint", () => {
    let app: FastifyInstance;

    beforeAll(async () => { app = await buildApp(); });
    afterAll(async () => { await app.close(); });

    it("is not rate limited", async () => {
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
        expect(res.statusCode).toBe(200);
      }
    });
  });
});
