import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { EngineManager } from "../src/agents/remote/engine-manager.js";
import { registerEngineManagementRoutes } from "../src/routes/engine-management.js";
import type { EngineCalls } from "../src/runners/local.js";
import type { EngineUpdateOperations } from "../src/agents/engine-update-operations.js";

const scopes: EngineScope[] = [
  { kind: "local" },
  { kind: "runner", runnerId: "r1" },
];
describe.each(scopes)("scoped engine API: $kind", (scope) => {
  it("uses the selected host for status, auth, plugins, updates and usage", async () => {
    const list = [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        signedIn: false,
        actions: ["update", "login"],
      },
    ];
    const status = {
      id: "claude",
      label: "Claude Code",
      installed: true,
      install: "claude install",
      path: "/bin/claude",
      update: { canUpdate: true },
    };
    const plugin = {
      installed: true,
      enabled: true,
      currentVersion: "1",
      latestVersion: "2",
      updateAvailable: true,
    };
    const call = vi.fn(async (op: string, request: unknown) => {
      if (op === "engine.list") return { entries: list };
      if (op === "engine.update.inspect") return { status };
      if (op === "engine.plugin.status") return plugin;
      if (op === "engine.plugin.apply")
        return {
          ...plugin,
          updateAvailable: false,
          ranCommands: [],
          error: null,
          probeFailed: false,
        };
      if (op === "engine.login.start")
        return {
          id: "login",
          engine: "claude",
          status: "waiting",
          expiresAt: "later",
          needsCode: true,
        };
      throw new Error(`Unexpected ${op}: ${JSON.stringify(request)}`);
    });
    const updates = {
      read: vi.fn(async () => ({
        claude: { id: "update", status: "running" },
      })),
      start: vi.fn(async () => ({ id: "update" })),
    };
    const providerPlans = vi.fn(async () => ({
      checkedAt: "now",
      providers: [],
    }));
    const calls = vi.fn((actual: EngineScope) => {
      expect(actual).toEqual(scope);
      return { call } as unknown as EngineCalls;
    });
    const manager = new EngineManager({
      local: {
        engines: { call } as unknown as EngineCalls,
        updates: updates as unknown as EngineUpdateOperations,
      },
      engineActions: {
        calls,
        updates: (actual) => {
          expect(actual).toEqual(scope);
          return updates as unknown as EngineUpdateOperations;
        },
        models: () => ({ models: [], defaultModel: null }),
        usage: (actual) => {
          expect(actual).toEqual(scope);
          return { providerPlans, redeemCodexReset: vi.fn() } as never;
        },
      },
    });
    const app = Fastify();
    await registerEngineManagementRoutes(app, manager, {
      enabledAgentTypes: async () => ["claude"],
      canManageEngineUpdates: async () => true,
    });
    try {
      const query = new URLSearchParams({
        scope: scope.kind,
        ...(scope.kind === "runner" ? { runnerId: scope.runnerId } : {}),
      });
      for (const route of ["status", "auth", "plugins"]) {
        expect(
          (await app.inject({ url: `/api/v1/engine-management/${route}` }))
            .statusCode
        ).toBe(400);
      }
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/engine-management/operations",
        payload: { scope, operation: { type: "provider_usage", force: "yes" } },
      });
      expect(invalid.statusCode).toBe(400);
      for (const route of ["status", "auth", "plugins"]) {
        const response = await app.inject({
          url: `/api/v1/engine-management/${route}?${query}&refresh=true`,
        });
        expect(response.statusCode).toBe(200);
        if (route === "status")
          expect(response.json()).toMatchObject({
            canManage: true,
            engines: [
              { id: "claude", update: { operation: { id: "update" } } },
            ],
          });
        if (route === "auth")
          expect(response.json()).toEqual({
            engines: [
              { engine: "claude", installed: true, signedIn: false },
              { engine: "codex", installed: false, signedIn: false },
            ],
          });
        if (route === "plugins")
          expect(response.json()).toMatchObject({
            statuses: [{ agentType: "claude", currentVersion: "1" }],
          });
      }
      for (const operation of [
        { type: "update", engine: "claude" },
        { type: "login_start", engine: "claude" },
        { type: "provider_usage", force: true },
        {
          type: "plugin_update",
          engine: "claude",
          plugin: "dispatch@dispatch",
        },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/engine-management/operations",
          payload: { scope, operation },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().ack.ok).toBe(true);
      }
      expect(updates.start).toHaveBeenCalledWith("claude", {});
      expect(providerPlans).toHaveBeenCalledWith({ force: true });
      expect(call).toHaveBeenCalledWith("engine.plugin.status", {
        engine: "claude",
        plugin: "dispatch@dispatch",
        refresh: true,
      });
      expect(call).toHaveBeenCalledWith(
        "engine.login.start",
        expect.objectContaining({ engine: "claude" }),
        expect.objectContaining({ onEvent: expect.any(Function) })
      );
    } finally {
      await app.close();
    }
  });
});
