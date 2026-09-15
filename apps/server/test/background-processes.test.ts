import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { BackgroundProcess } from "@dispatch/shared";
import { BackgroundProcesses } from "../src/agents/harness/background-processes.js";

const managers: BackgroundProcesses[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});
function setup() {
  const rows = new Map<string, BackgroundProcess>();
  const query = vi.fn(async (sql: string, values: string[] = []) => {
    if (sql.startsWith("INSERT")) rows.set(values[0], JSON.parse(values[2]));
    if (sql.startsWith("UPDATE") && values.length)
      rows.set(values[0], JSON.parse(values[1]));
    return {
      rows: sql.startsWith("SELECT")
        ? [...rows.values()]
            .filter((row) => row.agentId === values[0])
            .map((record) => ({ record }))
        : [],
    };
  });
  const onComplete = vi.fn();
  const onError = vi.fn();
  const manager = new BackgroundProcesses({
    pool: { query } as unknown as Pool,
    onComplete,
    onError,
  });
  managers.push(manager);
  return { manager, onComplete, onError, rows, query };
}

describe("background processes", () => {
  it("cancels a start still waiting for storage when its session stops", async () => {
    const { manager, query, onComplete } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    query.mockImplementationOnce(async () => {
      await gate;
      return { rows: [] };
    });
    const start = manager.start(
      "agent-a",
      { title: "Pending", command: "true" },
      "/tmp",
      processEnv()
    );
    const failed = expect(start).rejects.toThrow("cancelled");
    const stopped = manager.stopAgent("agent-a");
    release();
    await Promise.all([failed, stopped]);
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("stops timed-out commands and marks shutdown as interrupted without notifying", async () => {
    const { manager, onComplete } = setup();
    await manager.start(
      "agent-a",
      { title: "Timeout", command: "sleep 30", timeoutSeconds: 1 },
      "/tmp",
      processEnv()
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    expect((await manager.list("agent-a"))[0]).toMatchObject({
      status: "stopped",
    });
    await manager.start(
      "agent-b",
      { title: "Shutdown", command: "sleep 30" },
      "/tmp",
      processEnv()
    );
    await manager.shutdown();
    expect((await manager.list("agent-b"))[0]).toMatchObject({
      status: "interrupted",
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
  it("returns while running, captures both streams, persists the exit, and notifies once", async () => {
    const { manager, onComplete, rows } = setup();
    const process = await manager.start(
      "agent-a",
      {
        title: "Check",
        command: "printf stdout; printf stderr >&2; sleep 0.1; exit 3",
      },
      "/tmp",
      processEnv()
    );
    expect(process.status).toBe("running");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    expect(rows.get(process.id)).toMatchObject({
      status: "failed",
      exitCode: 3,
    });
    expect(rows.get(process.id)?.output).toContain("stdout");
    expect(rows.get(process.id)?.output).toContain("stderr");
    expect(await manager.list("agent-b")).toEqual([]);
  });

  it("only stops the owner's process and does not allow starts after shutdown", async () => {
    const { manager, onComplete } = setup();
    const process = await manager.start(
      "agent-a",
      { title: "Watch", command: "sleep 30" },
      "/tmp",
      processEnv()
    );
    expect(await manager.stop("agent-b", process.id)).toBe(false);
    expect(await manager.stop("agent-a", process.id)).toBe(true);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    expect((await manager.list("agent-a"))[0].status).toBe("stopped");
    await manager.shutdown();
    await expect(
      manager.start(
        "agent-a",
        { title: "No", command: "true" },
        "/tmp",
        processEnv()
      )
    ).rejects.toThrow("shutting down");
  });

  it("bounds output and records spawn errors", async () => {
    const { manager, onComplete } = setup();
    await manager.start(
      "agent-a",
      { title: "Output", command: "head -c 100000 /dev/zero" },
      "/tmp",
      processEnv()
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    const [record] = await manager.list("agent-a");
    expect(record.output.length).toBeLessThanOrEqual(65536);
    expect(record.truncated).toBe(true);
    await manager.start(
      "agent-b",
      { title: "Bad cwd", command: "true" },
      "/tmp/dispatch-background-missing-directory",
      processEnv()
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2), {
      timeout: 10000,
    });
    expect((await manager.list("agent-b"))[0].status).toBe("failed");
  });

  it("reconciles persisted running records and caps concurrent starts", async () => {
    const { manager, query } = setup();
    await manager.reconcile();
    expect(query.mock.calls[0][0]).toContain("interrupted");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        manager.start(
          "agent-a",
          { title: "Watch", command: "sleep 30" },
          "/tmp",
          processEnv()
        )
      )
    );
    await expect(
      manager.start(
        "agent-a",
        { title: "Extra", command: "true" },
        "/tmp",
        processEnv()
      )
    ).rejects.toThrow("limit reached");
  });
});

function processEnv() {
  return { PATH: process.env.PATH };
}
