import { expect, it, vi } from "vitest";
import type { EngineCapabilityOperation } from "@dispatch/runner-protocol/engine-management";
import { EngineManager } from "../src/agents/remote/engine-manager.js";

const operations = {
  model_catalog: { type: "model_catalog", engine: "codex" },
  provider_usage: { type: "provider_usage" },
  codex_reset: {
    type: "codex_reset",
    account: "fixture",
    requestId: "fixture",
  },
  plugin_status: { type: "plugin_status", engine: "codex", plugin: "fixture" },
  plugin_install: {
    type: "plugin_install",
    engine: "codex",
    plugin: "fixture",
  },
  plugin_update: { type: "plugin_update", engine: "codex", plugin: "fixture" },
} satisfies Record<
  EngineCapabilityOperation["type"],
  EngineCapabilityOperation
>;

it.each([{ kind: "local" }, { kind: "runner", runnerId: "fixture" }] as const)(
  "routes all legacy aliases through the engine actions of $kind",
  async (scope) => {
    const handle = vi.fn();
    const send = vi.fn();
    const models = vi.fn(() => ({ models: [], defaultModel: null }));
    const providerPlans = vi.fn(async () => ({
      checkedAt: "fixture",
      providers: [],
    }));
    const redeemCodexReset = vi.fn(async () => ({
      outcome: { code: "no_credit", windowsReset: 0 },
      error: null,
    }));
    const usage = vi.fn(() => ({ providerPlans, redeemCodexReset }));
    const call = vi.fn(async () => ({
      installed: true,
      enabled: true,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      ranCommands: [],
      probeFailed: false,
      error: null,
    }));
    const calls = vi.fn(() => ({ call }));
    const manager = new EngineManager({
      local: { capabilities: { handle } },
      remote: { send },
      engineActions: { models, usage, calls },
    } as never);
    for (const op of Object.values(operations)) {
      const reply = await manager.rpc(scope, op);
      const status = {
        agentType: "codex",
        installed: true,
        enabled: true,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        actions: ["update"],
      };
      const expected = {
        model_catalog: {
          type: "model_catalog",
          catalog: { models: [], defaultModel: null },
        },
        provider_usage: {
          type: "provider_usage",
          usage: { checkedAt: "fixture", providers: [] },
        },
        codex_reset: {
          type: "codex_reset",
          code: "no_credit",
          windowsReset: 0,
        },
        plugin_install: { type: "plugin_status", status },
        plugin_update: { type: "plugin_status", status },
        plugin_status: { type: "plugin_status", status },
      };
      expect(reply).toEqual({
        ok: true,
        capability: expected[op.type],
        ...((op.type === "plugin_install" || op.type === "plugin_update") && {
          ranCommands: [],
          probeFailed: false,
        }),
      });
    }
    expect(models).toHaveBeenCalledWith(scope, "codex", undefined);
    expect(usage.mock.calls).toEqual([[scope], [scope]]);
    expect(providerPlans).toHaveBeenCalledOnce();
    expect(redeemCodexReset).toHaveBeenCalledWith("fixture");
    expect(calls.mock.calls).toEqual([[scope], [scope], [scope]]);
    expect(
      call.mock.calls.map(([op, req]: unknown[]) => [
        op,
        (req as { action?: string }).action,
      ])
    ).toEqual([
      ["engine.plugin.status", undefined],
      ["engine.plugin.apply", "install"],
      ["engine.plugin.apply", "update"],
    ]);
    expect(handle).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
);

it.each(["Engine unavailable.", "The provider could not be reached."])(
  "preserves the operation's failure text on both placements: %s",
  async (message) => {
    const fail = () => {
      throw new Error(message);
    };
    const handle = vi.fn(),
      send = vi.fn();
    const manager = new EngineManager({
      local: { capabilities: { handle } },
      remote: { send },
      engineActions: {
        models: fail,
        usage: () => ({
          providerPlans: fail,
          redeemCodexReset: async () => ({ error: { message } }),
        }),
        calls: () => ({ call: fail }),
      },
    } as never);
    for (const scope of [
      { kind: "local" },
      { kind: "runner", runnerId: "fixture" },
    ] as const) {
      for (const op of Object.values(operations)) {
        const reply = manager.rpc(scope, op);
        if (op.type === "model_catalog" || op.type === "provider_usage")
          await expect(reply).rejects.toThrow(message);
        else
          await expect(reply).resolves.toEqual({ ok: false, error: message });
      }
    }
    expect(handle).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
);
