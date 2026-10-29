import { describe, expect, it, vi } from "vitest";
import {
  EngineUpdateOperations,
  type EngineOperationStore,
  type Installation,
  type UpdateObserver,
} from "../src/agents/engine-updates.js";
import type { RunCommandResult } from "../src/shared/lib/run-command.js";

function store(): EngineOperationStore {
  let data = {};
  let queue = Promise.resolve();
  return {
    exclusive(work) {
      const result = queue.then(async () => {
        const copy = structuredClone(data);
        const value = await work(copy);
        data = copy;
        return value;
      });
      queue = result.then(
        () => {},
        () => {}
      );
      return result;
    },
  };
}
const installation: Installation = {
  realPath: "/verified/bin/codex",
  source: "npm",
  canUpdate: true,
  reason: "Verified",
  command: "verified update",
  latestKey: "npm:codex",
  target: "/verified",
  run: { executable: "/verified/npm", args: ["update"] },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const done = { exitCode: 0, stdout: "updated", stderr: "" };
const readUntil = async (manager: EngineUpdateOperations, status: string) => {
  await vi.waitFor(async () =>
    expect((await manager.read()).codex?.status).toBe(status)
  );
  return (await manager.read()).codex!;
};

describe("durable engine update operations", () => {
  it("acknowledges before completion, streams bounded output, excludes duplicate starts and preserves result across reload", async () => {
    const storage = store();
    const completion = deferred<RunCommandResult>();
    let observer!: UpdateObserver;
    const run = vi.fn(async () => {
      await observer.spawned?.(12345);
      return completion.promise;
    });
    const manager = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      runner: (hooks) => {
        observer = hooks;
        return run;
      },
    });
    const started = await manager.start("codex", {});
    expect(started.status).toBe("running");
    expect(started.retryBlocked).toBe(true);
    expect(started).not.toHaveProperty("childPid");
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    observer.output?.("x".repeat(100_000) + "live progress");
    await vi.waitFor(async () =>
      expect((await manager.read()).codex?.output).toContain("live progress")
    );
    expect((await manager.read()).codex?.output.length).toBe(64_000);
    await expect(manager.start("codex", {})).rejects.toThrow("running");
    await expect(manager.start("claude", {})).rejects.toThrow("running");
    completion.resolve(done);
    const final = await readUntil(manager, "succeeded");
    expect(final.id).toBe(started.id);
    expect(final.finishedAt).toBeTruthy();
    expect(final.retryBlocked).toBe(false);
    expect(final.output).toContain("updated");
    const reloaded = new EngineUpdateOperations(storage);
    expect((await reloaded.read()).codex).toEqual(final);
  });

  it("atomically admits only one concurrent start", async () => {
    const storage = store();
    const completion = deferred<RunCommandResult>();
    const options = {
      prepare: async () => installation,
      runner: () => vi.fn(() => completion.promise),
      mayExist: () => true,
    };
    const first = new EngineUpdateOperations(storage, options);
    const results = await Promise.allSettled([
      first.start("codex", {}),
      first.start("opencode", {}),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    completion.resolve(done);
  });

  it.each(["exit", "timeout"])(
    "persists %s failure and permits a later retry",
    async (failure) => {
      const storage = store();
      const runner = vi.fn(async () => {
        if (failure === "timeout")
          throw new Error("Command timed out after 120 seconds.");
        return { exitCode: 1, stdout: "", stderr: "upgrade failed" };
      });
      const manager = new EngineUpdateOperations(storage, {
        prepare: async () => installation,
        runner: () => runner,
      });
      await manager.start("codex", {});
      const result = await readUntil(manager, "failed");
      expect(result.output).toContain(
        failure === "timeout" ? "timed out" : "upgrade failed"
      );
      expect(result.retryBlocked).toBe(false);
      expect((await new EngineUpdateOperations(storage).read()).codex).toEqual(
        result
      );
      await expect(manager.start("codex", {})).resolves.toMatchObject({
        status: "running",
      });
      await readUntil(manager, "failed");
    }
  );

  it("runs refresh first with separate bounds and never upgrades after refresh failure", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "refresh output",
      stderr: "metadata failed",
    }));
    const manager = new EngineUpdateOperations(store(), {
      prepare: async () => ({
        ...installation,
        run: {
          ...installation.run!,
          refresh: { executable: "/verified/brew", args: ["update"] },
        },
      }),
      runner: () => runner,
    });
    await manager.start("codex", {});
    expect((await readUntil(manager, "failed")).output).toContain(
      "metadata failed"
    );
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      "/verified/brew",
      ["update"],
      { env: undefined, timeoutMs: 60_000 }
    );
  });

  it("reports restart interruption and blocks conservatively until old owner and group are absent", async () => {
    const storage = store();
    const completion = deferred<RunCommandResult>();
    const first = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      runner: (observer) => async () => {
        await observer.spawned?.(12345);
        return completion.promise;
      },
    });
    await first.start("codex", {});
    await vi.waitFor(async () => {
      await storage.exclusive(async (records) =>
        expect(records.codex?.childPid).toBe(12345)
      );
    });
    const exists = vi.fn(() => true);
    const restarted = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      mayExist: exists,
      runner: () => async () => done,
    });
    expect((await restarted.read()).codex).toMatchObject({
      status: "interrupted",
      retryBlocked: true,
    });
    await expect(restarted.start("codex", {})).rejects.toThrow("uncertain");
    exists.mockImplementation((pid: number) => pid === process.pid);
    expect((await restarted.read()).codex).toMatchObject({
      status: "interrupted",
      retryBlocked: false,
    });
    expect(exists).toHaveBeenCalledWith(-12345);
    // The old mocked process must not outlive the test.
    completion.resolve(done);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await restarted.start("codex", {});
    await readUntil(restarted, "succeeded");
  });

  it("safely releases an unrecorded gated launch once its owner is absent", async () => {
    const storage = store();
    const completion = deferred<RunCommandResult>();
    const first = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      runner: () => () => completion.promise,
    });
    await first.start("codex", {});
    const restarted = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      mayExist: () => true,
    });
    expect((await restarted.read()).codex).toMatchObject({
      status: "interrupted",
      retryBlocked: false,
    });
    completion.resolve(done);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("fences a superseded executor before its next command, including updates of another engine", async () => {
    const storage = store();
    const refresh = deferred<RunCommandResult>();
    const oldRun = vi.fn(async () => refresh.promise);
    const errors = vi.fn();
    const old = new EngineUpdateOperations(storage, {
      prepare: async () => ({
        ...installation,
        run: {
          ...installation.run!,
          refresh: { executable: "/verified/brew", args: ["update"] },
        },
      }),
      runner: (observer) => async () => {
        await observer.spawned?.(12345);
        return oldRun();
      },
      onError: errors,
    });
    await old.start("codex", {});
    await vi.waitFor(() => expect(oldRun).toHaveBeenCalledOnce());
    const restarted = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      runner: () => async () => done,
      mayExist: (pid) => pid === process.pid,
    });
    expect((await restarted.read()).codex).toMatchObject({
      status: "interrupted",
      retryBlocked: false,
    });
    await restarted.start("opencode", {});
    refresh.resolve(done);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(oldRun).toHaveBeenCalledOnce();
    expect((await restarted.read()).codex?.status).toBe("interrupted");
  });

  it("rejects unverified installs without reserving or executing an operation", async () => {
    const runner = vi.fn();
    const manager = new EngineUpdateOperations(store(), {
      prepare: async () => ({
        ...installation,
        canUpdate: false,
        reason: "Manual update required",
      }),
      runner,
    });
    await expect(manager.start("codex", {})).rejects.toThrow(
      "Manual update required"
    );
    expect(await manager.read()).toEqual({});
    expect(runner).not.toHaveBeenCalled();
  });
});
