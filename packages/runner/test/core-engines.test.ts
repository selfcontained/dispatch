import { describe, expect, it, vi } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { engineHandlers } from "../src/core/engines.js";
import { SERVED_WHILE_FROZEN } from "../src/local/fence.js";
import type { EnginePort, Platform } from "../src/platform/types.js";

const workload = { run: vi.fn() } as unknown as Platform["workload"];

const starting = {
  id: "l1",
  engine: "claude",
  status: "starting" as const,
  needsCode: true,
};
const waiting = { ...starting, status: "waiting" as const, url: "https://x" };

function port(overrides: Partial<EnginePort> = {}): EnginePort {
  return {
    updateInspect: vi.fn(),
    updateSpawn: vi.fn(),
    updateRelease: vi.fn(),
    updateProbe: vi.fn(),
    operation: vi.fn(),
    pluginStatus: vi.fn(),
    pluginApply: vi.fn(),
    list: vi.fn(async () => ({ entries: [] })),
    loginStart: vi.fn(async (_request, onUpdate) => {
      onUpdate(starting);
      return waiting;
    }),
    loginSubmit: vi.fn(async () => waiting),
    loginStatus: vi.fn(async () => {
      throw new RunnerCallError({
        code: "not_found",
        message: "Sign-in not found.",
      });
    }),
    loginCancel: vi.fn(async () => waiting),
    close: vi.fn(),
    ...overrides,
  };
}

describe("the core's engine inventory and sign-in", () => {
  it("serves engine.list from the platform's port", async () => {
    const engines = port();
    const handlers = engineHandlers({ workload, engines });
    expect(
      await handlers["engine.list"]!({ refresh: true }, {} as never)
    ).toEqual({ entries: [] });
    expect(engines.list).toHaveBeenCalledWith({ refresh: true });
  });

  it("delegates plugin reads and changes without dropping failure detail", async () => {
    const status = {
      agentType: "codex" as const,
      installed: false,
      enabled: false,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      detectionError: "Fixture probe failure",
      actions: ["install" as const],
      ranCommands: ["plugin marketplace list --json"],
      error: "Fixture curated error",
      probeFailed: true,
    };
    const engines = port({
      pluginStatus: vi.fn(async () => status),
      pluginApply: vi.fn(async () => status),
    });
    const handlers = engineHandlers({ workload, engines });
    const read = {
      engine: "codex",
      plugin: "dispatch@dispatch",
      refresh: true,
    };
    const apply = {
      engine: "codex",
      plugin: "dispatch@dispatch",
      action: "install" as const,
      requestId: "fixture",
    };
    expect(await handlers["engine.plugin.status"]!(read, {} as never)).toEqual(
      status
    );
    expect(engines.pluginStatus).toHaveBeenCalledExactlyOnceWith(read);
    expect(await handlers["engine.plugin.apply"]!(apply, {} as never)).toEqual(
      status
    );
    expect(engines.pluginApply).toHaveBeenCalledExactlyOnceWith(apply);
  });

  it("reports a starting login as an event before the answer", async () => {
    const engines = port();
    const emit = vi.fn();
    const handlers = engineHandlers({ workload, engines });
    const request = { engine: "claude", restart: false, requestId: "r1" };
    expect(
      await handlers["engine.login.start"]!(request, { emit } as never)
    ).toEqual(waiting);
    expect(emit).toHaveBeenCalledWith({
      type: "login_update",
      login: starting,
    });
  });

  it("passes the port's errors through", async () => {
    const handlers = engineHandlers({ workload, engines: port() });
    await expect(
      handlers["engine.login.status"]!({ loginId: "x" }, {} as never)
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("leaves engines unsupported without a port, and serves reads while frozen", () => {
    expect(engineHandlers({ workload })).toEqual({});
    expect(SERVED_WHILE_FROZEN.has("engine.list")).toBe(true);
    expect(SERVED_WHILE_FROZEN.has("engine.login.status")).toBe(true);
    for (const op of [
      "engine.operation",
      "engine.update.inspect",
      "engine.update.probe",
    ])
      expect(SERVED_WHILE_FROZEN.has(op)).toBe(true);
    expect(SERVED_WHILE_FROZEN.has("engine.update.spawn")).toBe(false);
    expect(SERVED_WHILE_FROZEN.has("engine.update.release")).toBe(false);
    expect(SERVED_WHILE_FROZEN.has("engine.login.start")).toBe(false);
  });
});
