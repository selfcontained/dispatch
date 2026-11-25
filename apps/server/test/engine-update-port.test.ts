import { describe, expect, it, vi } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import {
  EngineUpdateOperations,
  type EngineOperationStore,
  EngineUpdateHost,
  engineUpdatePort,
} from "../src/agents/engine-updates.js";
import type { EngineCalls } from "../src/runners/local.js";

function fixture() {
  const command = vi.fn();
  const host = new EngineUpdateHost((observer) => async () => {
    await observer?.spawned?.(12345);
    command();
    observer?.output?.("fixture progress");
    return { exitCode: 0, stdout: "fixture progress", stderr: "" };
  });
  const call = vi.fn(async (op: string, request: never) => {
    switch (op) {
      case "engine.update.spawn":
        return host.spawn(request);
      case "engine.update.release":
        return host.release(request);
      case "engine.operation":
        return host.operation(request);
      default:
        throw new Error(`Unexpected fixture operation ${op}`);
    }
  });
  return { host, command, calls: { call } as unknown as EngineCalls, call };
}
describe("runner gated update execution", () => {
  it("starts no command before durable PID acknowledgement, and replays the same spawn", async () => {
    const { host, command } = fixture();
    const request = {
      requestId: "fixture",
      command: { executable: "/fixture/npm", args: ["update"] },
      timeoutMs: 1000,
    };
    expect(await host.spawn(request)).toEqual({
      operationId: "fixture",
      pid: 12345,
    });
    expect(await host.spawn(request)).toEqual({
      operationId: "fixture",
      pid: 12345,
    });
    expect(command).not.toHaveBeenCalled();
    await host.release({ operationId: "fixture" });
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(await host.operation({ operationId: "fixture" })).toEqual({
      type: "operation_state",
      operationId: "fixture",
      pid: 12345,
      running: false,
      output: "fixture progress",
      outputOffset: 16,
      result: { exitCode: 0, stdout: "fixture progress", stderr: "" },
    });
  });
  it("the coordinator adapter persists PID before releasing the gate", async () => {
    const { calls, command, call } = fixture();
    const spawned = vi.fn(async () => {
      expect(command).not.toHaveBeenCalled();
      expect(call.mock.calls.map(([op]) => op)).toEqual([
        "engine.update.spawn",
      ]);
    });
    const output = vi.fn();
    const result = await engineUpdatePort(calls).runner({ spawned, output })(
      "/fixture/npm",
      ["update"]
    );
    expect(spawned).toHaveBeenCalledExactlyOnceWith(12345);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "fixture progress",
      stderr: "",
    });
    expect(output).toHaveBeenCalledExactlyOnceWith("fixture progress");
  });
  it("failed PID persistence aborts the gate without running the command", async () => {
    const { calls, command } = fixture();
    await expect(
      engineUpdatePort(calls).runner({
        spawned: async () => {
          throw new Error("Fixture DB unavailable");
        },
      })("/fixture/npm", [])
    ).rejects.toThrow("Fixture DB unavailable");
    expect(command).not.toHaveBeenCalled();
  });
  it("an unreachable runner cannot clear the uncertain-outcome fence", async () => {
    const calls = {
      call: vi.fn(async () => {
        throw new RunnerCallError({
          code: "unavailable",
          message: "Fixture offline",
        });
      }),
    } as unknown as EngineCalls;
    expect(await engineUpdatePort(calls).processExists(12345)).toBe(true);
  });
  it("keeps main's unknown-outcome status and blocking after execution transport loss", async () => {
    let records = {};
    const store: EngineOperationStore = {
      exclusive: async (work) => work(records),
    };
    const manager = new EngineUpdateOperations(store, {
      prepare: async () => ({
        realPath: "/fixture/codex",
        source: "npm",
        canUpdate: true,
        reason: "Fixture verified",
        command: "fixture",
        latestKey: "unknown:fixture",
        target: "/fixture",
        run: { executable: "/fixture/npm", args: [] },
      }),
      verify: async () => "1.0.0",
      processExists: async () => true,
      runner: (observer) => async () => {
        await observer.spawned?.(12345);
        throw new RunnerCallError({
          code: "unavailable",
          message: "Fixture runner disconnected after release",
        });
      },
    });
    await manager.start("codex", {});
    await vi.waitFor(async () =>
      expect((await manager.read()).codex).toMatchObject({
        status: "interrupted",
        phase: "updating",
        retryBlocked: true,
        message:
          "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying.",
      })
    );
    await expect(manager.start("codex", {})).rejects.toThrow(
      "prior outcome is uncertain"
    );
  });
  it("reports progress while release is pending and holds it until execution ends", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const host = new EngineUpdateHost((observer) => async () => {
      await observer?.spawned?.(23456);
      observer?.output?.("fixture working");
      await completion;
      return { exitCode: 0, stdout: "fixture working", stderr: "" };
    });
    const calls = {
      call: async (op: string, request: never) => {
        if (op === "engine.update.spawn") return host.spawn(request);
        if (op === "engine.update.release") return host.release(request);
        if (op === "engine.operation") return host.operation(request);
        throw new Error(op);
      },
    } as EngineCalls;
    const output = vi.fn();
    let completed = false;
    const result = engineUpdatePort(calls)
      .runner({ spawned: async () => {}, output })("/fixture/npm", [])
      .then((value) => {
        completed = true;
        return value;
      });
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith("fixture working")
    );
    expect(completed).toBe(false);
    finish();
    expect((await result).exitCode).toBe(0);
    host.close();
  });
  it("never sends the coordinator PID to the workload runner during recovery", async () => {
    let records = {};
    const store: EngineOperationStore = {
      exclusive: async (work) => work(records),
    };
    await store.exclusive(async (rows) => {
      rows.codex = {
        id: "old",
        engineId: "codex",
        status: "running",
        phase: "updating",
        message: "fixture",
        output: "",
        startedAt: "fixture",
        updatedAt: "fixture",
        finishedAt: null,
        retryBlocked: true,
        owner: "old-coordinator",
        ownerPid: 65432,
        childPid: 12345,
        spawnGated: true,
        target: "fixture",
      };
    });
    const owner = vi.fn(() => false),
      child = vi.fn(async () => false);
    const manager = new EngineUpdateOperations(store, {
      mayExist: owner,
      processExists: child,
    });
    expect((await manager.read()).codex).toMatchObject({
      status: "interrupted",
      retryBlocked: false,
    });
    expect(owner).toHaveBeenCalledExactlyOnceWith(65432);
    expect(child).toHaveBeenCalledExactlyOnceWith(
      process.platform === "win32" ? 12345 : -12345
    );
  });
});
