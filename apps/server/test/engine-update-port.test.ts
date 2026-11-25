// Provider acts stay fixtures even if a fence regression reaches the host.
vi.mock("../src/agents/provider-plans.js", async (original) => ({
  ...(await original<typeof import("../src/agents/provider-plans.js")>()),
  loadProviderPlans: vi.fn(async () => ({
    checkedAt: "2026-11-24T12:00:00Z",
    providers: [],
  })),
  consumeCodexLimitReset: vi.fn(async () => ({
    code: "ok",
    windowsReset: 1,
    credit: null,
  })),
}));
import { createRunnerUsage } from "../src/agents/codex-reset.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { localEngineCalls, inProcessEngines } from "../src/runners/local.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-update-retention-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import {
  EngineUpdateOperations,
  type EngineOperationStore,
  EngineUpdateHost,
  engineUpdatePort,
} from "./helpers/native-engine-updates.js";
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

describe("engine update host lifetime", () => {
  const request = (requestId: string, timeoutMs = 1000) => ({
    requestId,
    command: { executable: "/usr/bin/true", args: [] },
    timeoutMs,
  });

  it("expires heavy results by age but never spawns a late duplicate", async () => {
    vi.useFakeTimers();
    const command = vi.fn();
    const host = new EngineUpdateHost(
      (observer) => async () => {
        await observer.spawned?.(12345);
        command();
        observer.output?.("x".repeat(64_000));
        return { exitCode: 0, stdout: "x".repeat(32_000), stderr: "" };
      },
      { retentionMs: 100, now: Date.now }
    );
    for (let i = 0; i < 200; i++) {
      await host.spawn(request(String(i)));
      await host.release({ operationId: String(i) });
    }
    // A normal reconnect can still read a completed result.
    expect(await host.operation({ operationId: "199" })).toMatchObject({
      running: false,
      result: { exitCode: 0 },
    });
    await vi.advanceTimersByTimeAsync(101);
    const retained = host as unknown as {
      operations: Map<string, unknown>;
      tombstones: Map<string, string>;
    };
    expect(retained.operations.size).toBe(0);
    expect(retained.tombstones.size).toBe(200);
    expect(new Set(retained.tombstones.values())).toEqual(
      new Set(["completed"])
    );
    await expect(host.spawn(request("0"))).rejects.toMatchObject({
      code: "unknown_outcome",
    });
    await expect(host.operation({ operationId: "199" })).rejects.toMatchObject({
      code: "unknown_outcome",
    });
    await expect(host.release({ operationId: "199" })).rejects.toMatchObject({
      code: "unknown_outcome",
    });
    expect(command).toHaveBeenCalledTimes(200);
    host.close();
  });

  it("logs loudly at the id safety ceiling and retains every existing id", async () => {
    const command = vi.fn(),
      log = vi.fn();
    const host = new EngineUpdateHost(
      (observer) => async () => {
        await observer.spawned?.(12345);
        command();
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { maxRequestIds: 2, log }
    );
    for (const id of ["a", "b"]) {
      await host.spawn(request(id));
      await host.release({ operationId: id });
    }
    await expect(host.spawn(request("c"))).rejects.toMatchObject({
      code: "busy",
    });
    await expect(host.spawn(request("d"))).rejects.toMatchObject({
      code: "busy",
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("2 request-id safety ceiling");
    await host.spawn(request("a"));
    expect(command).toHaveBeenCalledTimes(2);
    host.close();
  });

  it.each(["timeout", "shutdown"])(
    "an unreleased gate becomes terminal after %s without running",
    async (kind) => {
      const marker = path.join(root(), "ran");
      const host = new EngineUpdateHost();
      const { operationId } = await host.spawn({
        requestId: kind,
        command: {
          executable: "/bin/sh",
          args: ["-c", 'printf ran > "$1"', "fixture", marker],
        },
        timeoutMs: kind === "timeout" ? 20 : 1000,
      });
      if (kind === "shutdown") host.close();
      await vi.waitFor(async () =>
        expect(await host.operation({ operationId })).toMatchObject({
          running: false,
          error: expect.stringContaining("never released; command did not run"),
        })
      );
      // A late release cannot turn the rejected gate into an execution.
      await host.release({ operationId });
      expect(existsSync(marker)).toBe(false);
      host.close();
    }
  );

  it("the real local child settles a timed-out gate through the same engine port", async () => {
    const state = root();
    const marker = path.join(state, "ran");
    const runner = startTestLocalRunner(state, { env: { HOME: state } });
    try {
      await runner.ready();
      const { operationId } = await runner.session.call("engine.update.spawn", {
        requestId: "local-timeout",
        command: {
          executable: "/bin/sh",
          args: ["-c", 'printf ran > "$1"', "fixture", marker],
        },
        timeoutMs: 20,
      });
      await vi.waitFor(async () =>
        expect(
          await runner.session.call("engine.operation", { operationId })
        ).toMatchObject({
          running: false,
          error: expect.stringContaining("never released; command did not run"),
        })
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it("never retries a possibly delivered local spawn in a restarted or fallback host", async () => {
    const state = root();
    const crash = path.join(state, "crash-after-spawn");
    writeFileSync(crash, "");
    const runner = startTestLocalRunner(state, {
      env: { HOME: state, RUNNER_DIE_AFTER_ENGINE_SPAWN: crash },
    });
    const fallback = inProcessEngines({ claudeBin: "fixture" });
    const spawn = vi.spyOn(fallback, "updateSpawn");
    try {
      await runner.ready();
      await runner.session.call("runner.health", {});
      const calls = localEngineCalls(() => runner.session, fallback);
      await expect(
        calls.call("engine.update.spawn", request("lost-ack", 20))
      ).rejects.toMatchObject({
        code: "unknown_outcome",
      });
      await runner.ready(1);
      expect(runner.pids).toHaveLength(2);
      expect(spawn).not.toHaveBeenCalled();
      await expect(
        runner.session.call("engine.operation", { operationId: "lost-ack" })
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      fallback.close();
      await runner.stop();
    }
  });

  it("the durable coordinator never replays a lost spawn acknowledgement after restart", async () => {
    let records = {};
    const store: EngineOperationStore = {
      exclusive: async (work) => work(records),
    };
    const call = vi.fn(async (_op: string, _request: unknown) => {
      throw new RunnerCallError({
        code: "unknown_outcome",
        message: "Fixture lost spawn acknowledgement",
      });
    });
    const options = {
      ...engineUpdatePort({ call } as unknown as EngineCalls),
      verify: async () => "1.0.0",
      prepare: async () => ({
        realPath: "/fixture/codex",
        source: "npm" as const,
        canUpdate: true,
        reason: "fixture",
        command: "fixture",
        latestKey: "unknown:",
        target: "fixture",
        run: { executable: "/usr/bin/true", args: [] },
      }),
    };
    const first = new EngineUpdateOperations(store, options);
    await first.start("codex", {});
    await vi.waitFor(async () =>
      expect((await first.read()).codex).toMatchObject({
        status: "interrupted",
        message:
          "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying.",
      })
    );
    const restarted = new EngineUpdateOperations(store, options);
    expect((await restarted.read()).codex?.status).toBe("interrupted");
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0][0]).toBe("engine.update.spawn");
  });

  it("expired results keep main's unknown outcome and recover only by probing", async () => {
    let records = {};
    const host = new EngineUpdateHost(
      (observer) => async () => {
        await observer.spawned?.(12345);
        return { exitCode: 0, stdout: "fixture success", stderr: "" };
      },
      { retentionMs: 0 }
    );
    const call = vi.fn(async (op: string, input: never) => {
      if (op === "engine.update.spawn") return host.spawn(input);
      if (op === "engine.update.release") return host.release(input);
      if (op === "engine.operation") return host.operation(input);
      if (op === "engine.update.probe")
        return { alive: [false], version: "2.0.0" };
      throw new Error(op);
    });
    const manager = new EngineUpdateOperations(
      { exclusive: async (work) => work(records) },
      {
        ...engineUpdatePort({ call } as unknown as EngineCalls),
        prepare: async () => ({
          realPath: "/fixture/codex",
          source: "npm",
          canUpdate: true,
          reason: "fixture",
          command: "fixture",
          latestKey: "unknown:",
          target: "fixture",
          run: { executable: "/usr/bin/true", args: [] },
        }),
      }
    );
    await manager.start("codex", {});
    await vi.waitFor(async () =>
      expect((await manager.read()).codex).toMatchObject({
        status: "interrupted",
        retryBlocked: false,
        message:
          "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying.",
      })
    );
    expect(
      call.mock.calls.filter(([op]) => op === "engine.update.spawn")
    ).toHaveLength(1);
    expect(call.mock.calls).toContainEqual([
      "engine.update.probe",
      { pids: [12345], groups: true },
    ]);
    host.close();
  });
});

it("a real local child lost reset reply is never re-sent after restart or on fallback", async () => {
  const state = root();
  const log = path.join(state, "fixture-spends");
  const crash = path.join(state, "crash-after-reset");
  writeFileSync(crash, "");
  const runner = startTestLocalRunner(state, {
    env: {
      HOME: state,
      RUNNER_FIXTURE_RESET_LOG: log,
      RUNNER_DIE_AFTER_RESET: crash,
    },
  });
  const fallback = inProcessEngines({ claudeBin: "fixture" });
  const spend = vi.spyOn(fallback, "quotaReset");
  vi.spyOn(fallback, "usage").mockResolvedValue({
    checkedAt: "2026-11-24T12:00:00Z",
    providers: [],
  });
  try {
    await runner.ready();
    await runner.session.call("runner.health", {});
    const usage = createRunnerUsage(
      localEngineCalls(() => runner.session, fallback)
    );
    const key = "a8b3cda6-7890-4a17-a031-9affc78a1eba";
    const result = await usage.redeemCodexReset(key);
    expect(result.error?.possiblyConsumed).toBe(true);
    await runner.ready(1);
    expect(await usage.redeemCodexReset(key)).toEqual(result);
    expect(readFileSync(log, "utf8")).toBe(key + "\n");
    expect(spend).not.toHaveBeenCalled();
  } finally {
    fallback.close();
    await runner.stop();
  }
});

const fencedMutations = [
  [
    "engine.quota.reset",
    "quotaReset",
    { engine: "codex", account: "", requestId: "fixture" },
  ],
  [
    "engine.update.spawn",
    "updateSpawn",
    {
      requestId: "fixture",
      command: { executable: "/fixture/never-run", args: [] },
      timeoutMs: 1000,
    },
  ],
  ["engine.update.release", "updateRelease", { operationId: "fixture" }],
  [
    "engine.plugin.apply",
    "pluginApply",
    {
      engine: "codex",
      plugin: "dispatch@dispatch",
      action: "install",
      requestId: "fixture",
    },
  ],
] as const;
it.each(fencedMutations)(
  "a child fence on %s never reaches the fallback host",
  async (op, method, input) => {
    const fallback = inProcessEngines({ claudeBin: "fixture" });
    const mutate = vi.spyOn(fallback, method).mockResolvedValue({} as never);
    const call = vi.fn(async () => {
      throw new RunnerCallError({ code: "fenced", message: "fixture frozen" });
    });
    try {
      const calls = localEngineCalls(
        () => ({ connection: { state: "ready" }, call }) as never,
        fallback
      );
      await expect(calls.call(op, input as never)).rejects.toMatchObject({
        code: "fenced",
      });
      expect(mutate).not.toHaveBeenCalled();
      expect(call).toHaveBeenCalledWith(op, input, { wait: false });
    } finally {
      fallback.close();
    }
  }
);
it.each(fencedMutations)(
  "the in-process port fences %s even with no child",
  async (op, _method, input) => {
    const fallback = inProcessEngines(
      {
        claudeBin: "/fixture/never-run",
        codexBin: "/fixture/never-run",
        opencodeBin: "/fixture/never-run",
      },
      () => true
    );
    try {
      const calls = localEngineCalls(() => undefined, fallback);
      await expect(calls.call(op, input as never)).rejects.toMatchObject({
        code: "fenced",
      });
      await expect(calls.call("engine.usage", {})).resolves.toEqual({
        checkedAt: "2026-11-24T12:00:00Z",
        providers: [],
      });
      // This read uses the actual in-memory host and still answers while frozen.
      await expect(
        calls.call("engine.operation", { operationId: "fixture-absent" })
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      fallback.close();
    }
  }
);

it("model discovery cannot bypass a fenced child or an absent frozen child", async () => {
  const fallback = inProcessEngines({
    claudeBin: "/fixture/never-run",
    codexBin: "/fixture/never-run",
    opencodeBin: "/fixture/never-run",
  });
  const models = vi
    .spyOn(fallback, "models")
    .mockResolvedValue({ defaultModel: null, models: [] });
  const call = vi.fn(async () => {
    throw new RunnerCallError({ code: "fenced", message: "fixture frozen" });
  });
  try {
    await expect(
      localEngineCalls(
        () => ({ connection: { state: "ready" }, call }) as never,
        fallback
      ).call("engine.models", { engine: "codex" })
    ).rejects.toMatchObject({ code: "fenced" });
    expect(models).not.toHaveBeenCalled();
  } finally {
    fallback.close();
  }
  const frozen = inProcessEngines(
    {
      claudeBin: "/fixture/never-run",
      codexBin: "/fixture/never-run",
      opencodeBin: "/fixture/never-run",
    },
    () => true
  );
  try {
    await expect(
      localEngineCalls(() => undefined, frozen).call("engine.models", {
        engine: "codex",
      })
    ).rejects.toMatchObject({ code: "fenced" });
  } finally {
    frozen.close();
  }
});
