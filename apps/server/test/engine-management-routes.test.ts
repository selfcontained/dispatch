import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerEngineManagementRoutes } from "../src/routes/engine-management.js";
import {
  EngineManager,
  type RunnerEngineTransport,
} from "../src/agents/remote/engine-manager.js";
import type { EngineLogins } from "../src/agents/engine-login.js";
import type { EngineUpdateOperations } from "../src/agents/engine-updates.js";

function fakeLogins(): EngineLogins {
  return {
    status: vi.fn(async () => ({
      engine: "claude",
      installed: true,
      signedIn: true,
    })),
    start: vi.fn(),
    submitCode: vi.fn(),
    cancel: vi.fn(),
    get: vi.fn(),
    current: vi.fn(),
    close: vi.fn(),
  } as unknown as EngineLogins;
}

function fakeUpdates(): EngineUpdateOperations {
  return {
    start: vi.fn(),
    read: vi.fn(async () => ({})),
  } as unknown as EngineUpdateOperations;
}

describe("engine-management routes", () => {
  afterEach(() => vi.clearAllMocks());

  it("reads local inventory and rejects a missing scope", async () => {
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: { send: vi.fn() },
    });
    const test = Fastify();
    await registerEngineManagementRoutes(test, manager);

    const ok = await test.inject({
      method: "GET",
      url: "/api/v1/engine-management/inventory?scope=local",
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude" })])
    );

    const bad = await test.inject({
      method: "GET",
      url: "/api/v1/engine-management/inventory",
    });
    expect(bad.statusCode).toBe(400);

    await test.close();
  });

  it("forwards a runner-scoped operation to the transport", async () => {
    const send = vi.fn<RunnerEngineTransport["send"]>(async () => ({
      ok: true,
    }));
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: { send },
    });
    const test = Fastify();
    await registerEngineManagementRoutes(test, manager);

    const res = await test.inject({
      method: "POST",
      url: "/api/v1/engine-management/operations",
      payload: {
        scope: { kind: "runner", runnerId: "r1" },
        operation: { type: "login_start", engine: "claude" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ack).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(
      "r1",
      { type: "login_start", engine: "claude" },
      undefined
    );

    await test.close();
  });

  it("rejects a malformed operation body", async () => {
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: { send: vi.fn() },
    });
    const test = Fastify();
    await registerEngineManagementRoutes(test, manager);

    const res = await test.inject({
      method: "POST",
      url: "/api/v1/engine-management/operations",
      payload: {
        scope: { kind: "local" },
        operation: { type: "launch_rocket" },
      },
    });
    expect(res.statusCode).toBe(400);

    await test.close();
  });
});
