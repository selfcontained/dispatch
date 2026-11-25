import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@dispatch/runner-protocol/contract";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { EngineWorkload } from "../src/agents/remote/engine-runner-executor.js";
import { localEngineCalls } from "../src/runners/local.js";
import { runnerPluginChecker } from "../src/routes/plugin.js";

const status = {
  agentType: "codex" as const,
  installed: true,
  enabled: false,
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  detectionError: "Fixture probe failure with detail.",
};
function fixture() {
  const result = {
    status,
    ranCommands: ["plugin marketplace upgrade dispatch --json"],
    error: "Failed to refresh the dispatch marketplace.",
    probeFailed: true,
  };
  const plugins = {
    getStatus: vi.fn(async () => status),
    install: vi.fn(async () => result),
    update: vi.fn(async () => result),
  };
  const port = new EngineWorkload({
    plugins,
    installations: async () => [],
    logins: { resolveBin: async () => null },
  });
  return { port, plugins, result };
}
describe("plugin operations through the engine port", () => {
  it("retains every failure field through in-process operations and the main adapter", async () => {
    const { port, plugins, result } = fixture();
    const calls = localEngineCalls(() => undefined, port);
    const checker = runnerPluginChecker(calls);
    expect(await checker.getStatus("codex", { forceRefresh: true })).toEqual(
      status
    );
    expect(plugins.getStatus).toHaveBeenCalledExactlyOnceWith("codex", {
      forceRefresh: true,
    });
    expect(await checker.update("codex")).toEqual(result);
    expect(plugins.update).toHaveBeenCalledExactlyOnceWith("codex");
    expect(await checker.install("codex")).toEqual(result);
    port.close();
  });
  it("uses a ready child's plugin result and the same port on child loss", async () => {
    const { port, plugins, result } = fixture();
    const call = vi.fn(async () => ({ ...status, actions: ["update"] }));
    const child = { connection: { state: "ready" }, call } as unknown as Runner;
    const checker = runnerPluginChecker(localEngineCalls(() => child, port));
    expect(await checker.getStatus("codex")).toEqual(status);
    expect(call).toHaveBeenCalledWith(
      "engine.plugin.status",
      {
        engine: "codex",
        plugin: "dispatch@dispatch",
        refresh: false,
      },
      undefined
    );
    expect(plugins.getStatus).not.toHaveBeenCalled();
    call.mockRejectedValue(
      new RunnerCallError({
        code: "unavailable",
        message: "Fixture disconnected",
      })
    );
    expect(await checker.install("codex")).toEqual(result);
    expect(plugins.install).toHaveBeenCalledOnce();
    port.close();
  });
  it("rejects an unrelated plugin before invoking a host command", async () => {
    const { port, plugins } = fixture();
    await expect(
      port.pluginStatus({ engine: "codex", plugin: "unrelated" })
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(plugins.getStatus).not.toHaveBeenCalled();
    port.close();
  });
});
