import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@dispatch/runner-protocol/contract";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { EngineWorkload } from "../../../packages/runner/src/workload/agents/remote/engine-runner-executor.js";
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
    plugins: new Map([["dispatch@dispatch", plugins]]),
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
      // One attempt: a child that cannot answer is not waited for. The read's
      // deadline is the adapter's own, not the transport's.
      expect.objectContaining({ wait: false, timeoutMs: null })
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
  it("never starts a second engine session: a deferred model lookup at the child is waited for, and made here once only when its connection is lost", async () => {
    const models = vi.fn(async () => ({
      choices: [],
      defaultModel: null,
    }));
    const here = { models } as unknown as EngineWorkload;
    let lose: (error: unknown) => void = () => {};
    const call = vi.fn(
      (op: string) =>
        new Promise((_, reject) => {
          if (op === "engine.models") lose = reject;
        })
    );
    const child = { connection: { state: "ready" }, call } as unknown as Runner;
    const calls = localEngineCalls(() => child, here);
    const lookup = calls.call("engine.models", { engine: "codex" } as never);
    // The child's engine session may be running: nothing starts here.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(models).not.toHaveBeenCalled();
    expect(call.mock.calls.filter(([op]) => op === "engine.models")).toEqual([
      [
        "engine.models",
        { engine: "codex" },
        expect.objectContaining({ wait: false, timeoutMs: null }),
      ],
    ]);
    // The child went (its connection lost): it is not running it any more.
    lose(new RunnerCallError({ code: "unknown_outcome", message: "lost" }));
    await lookup;
    expect(models).toHaveBeenCalledOnce();
  });

  it("a caller's abort after the fallback here has started rejects at once", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const here = {
      pluginStatus: vi.fn(() => {
        started();
        return new Promise(() => {});
      }),
    } as unknown as EngineWorkload;
    const controller = new AbortController();
    const calls = localEngineCalls(() => undefined, here);
    const status = calls.call(
      "engine.plugin.status",
      { engine: "codex", plugin: "dispatch@dispatch", refresh: false },
      { signal: controller.signal }
    );
    const rejected = expect(status).rejects.toMatchObject({
      code: "cancelled",
    });
    await running;
    controller.abort();
    await rejected;
  });

  it.each(["engine.update.release", "engine.plugin.apply"] as const)(
    "%s never retries or falls back after an uncertain reply",
    async (op) => {
      const { port, plugins } = fixture();
      const release = vi.spyOn(port, "updateRelease");
      const error = new RunnerCallError({
        code: "unknown_outcome",
        message: "Fixture lost acknowledgement",
      });
      const call = vi.fn().mockRejectedValue(error);
      const child = {
        connection: { state: "ready" },
        call,
      } as unknown as Runner;
      const calls = localEngineCalls(() => child, port);
      const input =
        op === "engine.update.release"
          ? { operationId: "fixture" }
          : {
              engine: "codex" as const,
              plugin: "dispatch@dispatch",
              action: "install" as const,
              requestId: "fixture",
            };
      await expect(calls.call(op, input as never)).rejects.toBe(error);
      expect(call).toHaveBeenCalledExactlyOnceWith(op, input, { wait: false });
      expect(release).not.toHaveBeenCalled();
      expect(plugins.install).not.toHaveBeenCalled();
      port.close();
    }
  );
  it("rejects an unrelated plugin before invoking a host command", async () => {
    const { port, plugins } = fixture();
    await expect(
      port.pluginStatus({ engine: "codex", plugin: "unrelated" })
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(plugins.getStatus).not.toHaveBeenCalled();
    port.close();
  });
});
