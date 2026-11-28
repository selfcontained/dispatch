import {
  forgetLearnedAgentModels,
  setLearnedAgentModels,
  onStoredModelCatalogRead,
} from "../src/shared/agent-models.js";
import {
  fixtureEngineActions,
  type FixtureEngineDeps,
  type RunnerEngineTransport,
} from "./helpers/engine-actions.js";
import { describe, expect, it, vi } from "vitest";

import type { EngineLogin } from "@dispatch/shared";
import type { EngineOperationEvent } from "@dispatch/runner-protocol/engine-management";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";

import { EngineManager as ActualEngineManager } from "../src/agents/remote/engine-manager.js";

// T29 actions are supplied separately from legacy inventory/sign-in fixture transport.
class EngineManager extends ActualEngineManager {
  constructor(deps: FixtureEngineDeps) {
    super({
      ...deps,
      engineActions: fixtureEngineActions(deps),
    });
  }
}
import { localEngineWorkload } from "../../../packages/runner/src/workload/agents/remote/engine-runner-executor.js";
import type { EngineUpdateOperations } from "./helpers/native-engine-updates.js";
import { localEngineCalls, type EngineCalls } from "../src/runners/local.js";

vi.mock(
  "../../../packages/runner/src/workload/agents/engine-availability.js",
  async () => {
    const actual = await vi.importActual<
      typeof import("../../../packages/runner/src/workload/agents/engine-availability.js")
    >("../../../packages/runner/src/workload/agents/engine-availability.js");
    return {
      ...actual,
      engineStatuses: vi.fn(async () => [
        {
          id: "claude",
          label: "Claude Code",
          installed: true,
          path: "/bin/claude",
          version: null,
          install: "",
        },
        {
          id: "codex",
          label: "Codex",
          installed: false,
          path: null,
          version: null,
          install: "",
        },
        {
          id: "opencode",
          label: "OpenCode",
          installed: false,
          path: null,
          version: null,
          install: "",
        },
      ]),
      withEngineVersions: vi.fn(async (statuses) =>
        statuses.map((s: any) => ({
          ...s,
          version: s.installed ? "1.2.3" : null,
        }))
      ),
    };
  }
);

vi.mock(
  "../../../packages/runner/src/workload/agents/engine-updates.js",
  async () => {
    const actual = await vi.importActual<
      typeof import("../../../packages/runner/src/workload/agents/engine-updates.js")
    >("../../../packages/runner/src/workload/agents/engine-updates.js");
    return {
      ...actual,
      withEngineUpdates: vi.fn(async (statuses) =>
        statuses.map((s: any) => ({
          ...s,
          update: {
            canUpdate: s.installed,
            available: false,
            reason: "",
            command: "",
            latestVersion: null,
            latestPending: false,
          },
        }))
      ),
    };
  }
);

const waiting: EngineLogin = {
  id: "login-1",
  engine: "claude",
  status: "waiting",
  needsCode: true,
  url: "https://example.com",
  expiresAt: new Date().toISOString(),
};

/** The local runner's engine calls, answered by `answer` (or as below). */
function fakeEngines(
  answer?: (op: string, input: any, options?: any) => unknown
): EngineCalls & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (op: string, input: any, options?: any) => {
      if (answer) return answer(op, input, options);
      if (op === "engine.list") return { entries: [] };
      if (op === "engine.login.start") return waiting;
      throw new RunnerCallError({
        code: "not_found",
        message: "Sign-in not found.",
      });
    }),
  } as never;
}

function fakeUpdates(
  overrides: Partial<EngineUpdateOperations> = {}
): EngineUpdateOperations {
  return {
    start: vi.fn(async (_engine, _overrides, action) => {
      if (action === "install")
        throw new RunnerCallError({
          code: "unsupported",
          message:
            "Claude Code is installed manually on this machine; there is no automatic install here.",
        });
      return { id: "op-1" };
    }),
    read: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as EngineUpdateOperations;
}

function fakeTransport(
  overrides: Partial<RunnerEngineTransport> = {}
): RunnerEngineTransport {
  return {
    send: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
}

describe("EngineManager local scope", () => {
  it("builds local inventory through the local runner's engine.list", async () => {
    // The posix-user port in process, its CLI a stand-in that is signed in.
    const port = localEngineWorkload(
      {},
      {
        command: () => ({
          bin: process.execPath,
          args: [
            "-e",
            'console.log(JSON.stringify({ loggedIn: true, email: "me@example.com" }))',
          ],
        }),
      }
    );
    const manager = new EngineManager({
      local: {
        engines: localEngineCalls(() => undefined, port),
        updates: fakeUpdates(),
      },
      remote: fakeTransport(),
    });
    const inventory = (await manager.inventory({ kind: "local" }))!;
    const claude = inventory.find((e) => e.id === "claude")!;
    expect(claude).toEqual({
      id: "claude",
      path: "/bin/claude",
      label: "Claude Code",
      installed: true,
      signedIn: true,
      version: "1.2.3",
      detail: "me@example.com",
      actions: ["update", "login", "login_cancel"],
    });

    const codex = inventory.find((e) => e.id === "codex")!;
    expect(codex.installed).toBe(false);
    expect(codex.actions).toEqual([]);
    port.close();
  });

  it("never offers automatic install locally", async () => {
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "install", engine: "claude" }
    );
    expect(ack).toMatchObject({ ok: false, unsupported: true });
  });

  it("routes update through the existing EngineUpdateOperations", async () => {
    const updates = fakeUpdates();
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "update", engine: "claude" }
    );
    expect(ack).toMatchObject({ ok: true, operationId: "op-1" });
    expect(updates.start).toHaveBeenCalledWith("claude", {});
  });

  it("routes sign-in through the local runner", async () => {
    const engines = fakeEngines();
    const manager = new EngineManager({
      local: { engines, updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "login_start", engine: "claude" }
    );
    expect(ack).toEqual({ ok: true, login: waiting });
    expect(engines.call).toHaveBeenCalledWith(
      "engine.login.start",
      { engine: "claude", restart: false, requestId: expect.any(String) },
      { onEvent: expect.any(Function) }
    );
  });

  it("answers a sign-in error as main's ack", async () => {
    const manager = new EngineManager({
      local: {
        engines: fakeEngines((op) => {
          throw new RunnerCallError(
            op === "engine.login.start"
              ? {
                  code: "unsupported",
                  message: "OpenCode has no sign-in flow.",
                }
              : { code: "not_found", message: "Sign-in not found." }
          );
        }),
        updates: fakeUpdates(),
      },
      remote: fakeTransport(),
    });
    const local = { kind: "local" } as const;
    expect(
      await manager.login(local, { type: "login_start", engine: "opencode" })
    ).toEqual({ ok: false, error: "OpenCode has no sign-in flow." });
    expect(
      await manager.login(local, { type: "login_status", loginId: "x" })
    ).toEqual({ ok: false, error: "Sign-in not found." });
  });

  it("knows the current login from the moment it exists", async () => {
    let release!: () => void;
    const linked = new Promise<void>((resolve) => (release = resolve));
    const starting = {
      ...waiting,
      status: "starting" as const,
      url: undefined,
    };
    const engines = fakeEngines(async (op, _input, options) => {
      if (op === "engine.login.start") {
        options.onEvent({ type: "login_update", login: starting });
        await linked;
        return waiting;
      }
      if (op === "engine.login.status") return starting;
      if (op === "engine.login.cancel")
        return { ...waiting, status: "cancelled" };
      throw new Error(op);
    });
    const manager = new EngineManager({
      local: { engines, updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const local = { kind: "local" } as const;
    expect(await manager.currentLogin(local, "claude")).toEqual({ ok: true });
    const started = manager.login(local, {
      type: "login_start",
      engine: "claude",
    });
    await vi.waitFor(() =>
      expect(engines.call).toHaveBeenCalledWith(
        "engine.login.start",
        expect.anything(),
        expect.anything()
      )
    );
    expect(await manager.currentLogin(local, "claude")).toEqual({
      ok: true,
      login: starting,
    });
    release();
    await started;
    // Closing cancels it.
    await manager.closeLogins(local);
    expect(engines.call).toHaveBeenCalledWith("engine.login.cancel", {
      loginId: "login-1",
    });
  });

  it("reports sign-in status from the inventory", async () => {
    const manager = new EngineManager({
      local: {
        engines: fakeEngines(() => ({
          entries: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: true,
              version: "1",
              detail: "me@example.com",
              actions: [],
            },
            {
              id: "codex",
              label: "Codex",
              installed: true,
              signedIn: false,
              version: "1",
              actions: [],
            },
          ],
        })),
        updates: fakeUpdates(),
      },
      remote: fakeTransport(),
    });
    expect(await manager.signInStatus({ kind: "local" })).toEqual([
      {
        engine: "claude",
        installed: true,
        signedIn: true,
        detail: "me@example.com",
      },
      { engine: "codex", installed: true, signedIn: false },
    ]);
  });
});

describe("EngineManager runner scope", () => {
  it("forwards operations to the injected transport", async () => {
    const transport = fakeTransport();
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: transport,
    });
    await manager.rpc(
      { kind: "runner", runnerId: "r1" },
      { type: "login_start", engine: "claude" }
    );
    expect(transport.send).toHaveBeenCalledWith(
      "r1",
      { type: "login_start", engine: "claude", restart: false },
      undefined
    );
  });

  it("reads inventory from the runner's streamed inventory event", async () => {
    const transport = fakeTransport({
      send: vi.fn(async (_r, _op, onEvent) => {
        onEvent?.({
          type: "inventory",
          entries: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: true,
              version: "9.9.9",
              actions: ["login"],
            },
          ],
        } satisfies EngineOperationEvent);
        return { ok: true };
      }),
    });
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: transport,
    });
    const inventory = await manager.inventory({
      kind: "runner",
      runnerId: "r1",
    });
    expect(inventory).toEqual([
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        signedIn: true,
        version: "9.9.9",
        actions: ["login"],
      },
    ]);
  });

  it("does not invent inventory when a runner rejects the current operation", async () => {
    const transport = fakeTransport({
      send: vi.fn(async () => ({
        ok: false,
        error: "unknown command",
        unsupported: true,
      })),
    });
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: transport,
    });
    await expect(
      manager.inventory({ kind: "runner", runnerId: "r1" })
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("announces nothing while a runner's engines are unknown", async () => {
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: fakeTransport({
        send: vi.fn(async () => ({ ok: false, error: "fenced" })),
      }),
    });
    const scope = { kind: "runner" as const, runnerId: "r1" };
    const listener = vi.fn();
    manager.onChanged(scope, listener);
    expect(await manager.inventory(scope)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies onChanged listeners after a state-changing operation", async () => {
    const transport = fakeTransport({
      send: vi.fn(async (_r, op) => {
        if (op.type === "status") {
          return { ok: true };
        }
        return { ok: true };
      }),
    });
    const manager = new EngineManager({
      local: { engines: fakeEngines(), updates: fakeUpdates() },
      remote: transport,
    });
    const scope = { kind: "runner" as const, runnerId: "r1" };
    const listener = vi.fn();
    const unsubscribe = manager.onChanged(scope, listener);
    await manager.rpc(scope, { type: "login_start", engine: "claude" });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

it("usage and reset RPC aliases share Dispatch's runner coordinator without legacy host calls", async () => {
  const report = { checkedAt: "2026-11-24T12:00:00Z", providers: [] };
  const outcome = {
    code: "future_provider_code",
    windowsReset: 2.5,
    credit: { id: "credit", title: "Reset", expiresAt: null },
  };
  const usage = vi.fn(() => ({
    providerPlans: vi.fn(async () => report),
    redeemCodexReset: vi.fn(async () => ({
      outcome,
      error: null,
      usage: report,
      refreshError: null,
    })),
  }));
  const handle = vi.fn();
  const send = vi.fn();
  const calls = vi.fn();
  const manager = new ActualEngineManager({
    local: { capabilities: { handle } },
    remote: { send },
    engineActions: { usage, calls },
  } as never);
  for (const scope of [
    { kind: "local" },
    { kind: "runner", runnerId: "fixture-runner" },
  ] as const) {
    expect(await manager.rpc(scope, { type: "provider_usage" })).toEqual({
      ok: true,
      capability: { type: "provider_usage", usage: report },
    });
    expect(
      await manager.rpc(scope, {
        type: "codex_reset",
        account: "legacy-precondition",
        requestId: "fixture",
      })
    ).toEqual({ ok: true, capability: { type: "codex_reset", ...outcome } });
    expect(usage).toHaveBeenCalledWith(scope);
  }
  expect(handle).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(calls).not.toHaveBeenCalled();
});

describe("model catalogs and sign-in refresh triggers", () => {
  it("serves local and runner catalogs and stored effort without waiting for a host", async () => {
    const remote = fakeTransport({
      send: vi.fn(async () => {
        throw Error("No host read");
      }),
    });
    const engines = fakeEngines(() => {
      throw Error("No engine start");
    });
    const manager = new EngineManager({
      local: { engines, updates: fakeUpdates() },
      remote,
    });
    const scheduled = vi.fn();
    const stop = onStoredModelCatalogRead(scheduled);
    try {
      for (const id of ["local", "runner-fixture"]) {
        const effort = [
          { value: "high", name: "High", description: "Lossless description" },
        ];
        setLearnedAgentModels("codex", [{ id, label: id, effort }], id, id);
        const scope =
          id === "local"
            ? ({ kind: "local" } as const)
            : ({ kind: "runner", runnerId: id } as const);
        expect(
          await manager.rpc(scope, {
            type: "model_catalog",
            engine: "codex",
            model: id,
          })
        ).toEqual({
          ok: true,
          capability: {
            type: "model_catalog",
            catalog: { defaultModel: id, models: [{ id, label: id, effort }] },
          },
        });
        expect(scheduled).toHaveBeenCalledWith(id, "codex", id);
      }
      expect(remote.send).not.toHaveBeenCalled();
      expect(engines.call).not.toHaveBeenCalled();
    } finally {
      stop();
      forgetLearnedAgentModels();
    }
  });
  it("invalidates once after completed sign-in on each runner, never for waiting or failed logins", async () => {
    const changed = vi.fn();
    let status: EngineLogin["status"] = "waiting";
    const login = () => ({ ...waiting, status });
    const manager = new EngineManager({
      onSignedIn: changed,
      local: { engines: fakeEngines(() => login()), updates: fakeUpdates() },
      remote: fakeTransport({
        send: vi.fn(async () => ({ ok: true, login: login() })),
      }),
    });
    for (const scope of [
      { kind: "local" },
      { kind: "runner", runnerId: "fixture" },
    ] as const) {
      status = "waiting";
      await manager.login(scope, { type: "login_start", engine: "claude" });
      expect(changed).not.toHaveBeenCalledWith(scope, "claude");
      status = "failed";
      await manager.login(scope, { type: "login_status", loginId: waiting.id });
      expect(changed).not.toHaveBeenCalledWith(scope, "claude");
      status = "succeeded";
      await manager.login(scope, { type: "login_status", loginId: waiting.id });
      await manager.login(scope, { type: "login_status", loginId: waiting.id });
      expect(changed).toHaveBeenCalledWith(scope, "claude");
    }
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
