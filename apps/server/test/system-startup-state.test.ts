import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerSystemRoutes } from "../src/routes/system.js";
import { StartupStateStore } from "../src/server/startup-state.js";

describe("startup health route", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("remains reachable through a database outage and reports ready after recovery", async () => {
    const app = Fastify();
    apps.push(app);
    const startupState = new StartupStateStore();
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ now: "2026-07-24T00:00:00.000Z" }],
      })),
    };

    // The remaining SystemRouteDeps are used only by their respective route
    // handlers. This test exercises the health contract in isolation.
    await registerSystemRoutes(app, {
      pool,
      startupState,
    } as never);

    const initializing = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(initializing.statusCode).toBe(503);
    expect(initializing.json()).toMatchObject({
      status: "initializing",
      error: "DATABASE_UNAVAILABLE",
      retryable: true,
    });
    expect(pool.query).not.toHaveBeenCalled();

    startupState.setDatabaseUnavailable("password authentication failed");
    const unavailable = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      status: "database_unavailable",
      error: "DATABASE_UNAVAILABLE",
      detail: "password authentication failed",
      retryable: true,
    });
    expect(pool.query).not.toHaveBeenCalled();

    startupState.setReady();
    const recovered = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: "ok",
      db: "ok",
      now: "2026-07-24T00:00:00.000Z",
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
