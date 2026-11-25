import { fixtureEngineActions } from "./helpers/engine-actions.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerEngineManagementRoutes } from "../src/routes/engine-management.js";
import {
  EngineManager as ActualEngineManager,
  type RunnerEngineTransport,
} from "../src/agents/remote/engine-manager.js";

// T29 actions are supplied separately from legacy inventory/sign-in fixture transport.
class EngineManager extends ActualEngineManager {
  constructor(
    deps: Omit<
      ConstructorParameters<typeof ActualEngineManager>[0],
      "engineActions"
    >
  ) {
    super({
      ...deps,
      engineActions: fixtureEngineActions(deps),
    });
  }
}
import type { EngineCalls } from "../src/runners/local.js";
import type { EngineUpdateOperations } from "./helpers/native-engine-updates.js";
import type { AgentRecord } from "@dispatch/shared";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { agentForClient } from "../src/server/agent-client-view.js";

function fakeEngines(): EngineCalls {
  return {
    call: vi.fn(async (op: string) => {
      if (op === "engine.list")
        return {
          entries: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: true,
              version: "1",
              actions: [],
            },
          ],
        };
      throw new Error(op);
    }),
  } as never;
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
      local: { engines: fakeEngines(), updates: fakeUpdates() },
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
      local: { engines: fakeEngines(), updates: fakeUpdates() },
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

  it("starts and resumes sign-in on the runner projected from the agent placement", async () => {
    const storedAgent = {
      agentArgs: [],
      cwd: "/work/project",
      placement: placementForRunner("runner-42"),
    } as AgentRecord;
    const agent = agentForClient(storedAgent, false);
    expect(agent.engineLoginRunnerId).toBe("runner-42");
    expect(
      agentForClient({ ...storedAgent, placement: controllerPlacement }, false)
        .engineLoginRunnerId
    ).toBeUndefined();

    const engines = fakeEngines();
    const login = {
      id: "login-42",
      engine: "claude",
      status: "waiting",
      needsCode: true,
    } as const;
    const send = vi.fn<RunnerEngineTransport["send"]>(async (_id, operation) =>
      operation.type === "status" ? { ok: true } : { ok: true, login }
    );
    const manager = new EngineManager({
      local: { engines, updates: fakeUpdates() },
      remote: { send },
    });
    const app = Fastify();
    await registerEngineManagementRoutes(app, manager);
    const scope = { kind: "runner", runnerId: agent.engineLoginRunnerId };
    const request = (operation: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/engine-management/operations",
        payload: { scope, operation },
      });
    const status = { type: "login_status", engine: "claude" };
    try {
      expect((await request(status)).json()).toEqual({ ack: { ok: true } });
      expect(send).not.toHaveBeenCalled();
      const start = { type: "login_start", engine: "claude", restart: false };
      expect((await request(start)).json()).toEqual({
        ack: { ok: true, login },
      });
      expect((await request(status)).json()).toEqual({
        ack: { ok: true, login },
      });
      const submit = {
        type: "login_submit",
        loginId: login.id,
        code: "test-code",
      };
      const cancel = { type: "login_cancel", loginId: login.id };
      await request(submit);
      await request(cancel);
      expect(
        send.mock.calls
          .filter(([, op]) => op.type !== "status")
          .map(([runnerId, operation]) => [runnerId, operation])
      ).toEqual([
        ["runner-42", start],
        ["runner-42", { type: "login_status", loginId: login.id }],
        ["runner-42", submit],
        ["runner-42", cancel],
      ]);
      expect(
        vi
          .mocked(engines.call)
          .mock.calls.filter(([op]) => op !== "engine.list")
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed operation body", async () => {
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
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
  it.each([{ kind: "local" }, { kind: "runner", runnerId: "fixture" }])(
    "applies main's enabled plugin types to %j",
    async (scope) => {
      const app = Fastify();
      const rpc = vi.fn();
      try {
        await registerEngineManagementRoutes(
          app,
          { rpc } as unknown as EngineManager,
          { enabledAgentTypes: async () => ["claude"] }
        );
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/engine-management/operations",
          payload: {
            scope,
            operation: {
              type: "plugin_install",
              engine: "codex",
              plugin: "dispatch@dispatch",
            },
          },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: "codex is not an enabled agent type.",
        });
        expect(rpc).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
});
