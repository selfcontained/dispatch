import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import {
  EngineUpdateOperations,
  engineOperationStore,
  type Installation,
} from "../src/agents/engine-updates.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query(
    "DELETE FROM settings WHERE key = 'engine_update_operations'"
  );
});
const installation: Installation = {
  realPath: "/mock/codex",
  source: "npm",
  canUpdate: true,
  reason: "Verified fixture",
  command: "mock update",
  latestKey: "npm:codex",
  target: "/mock",
  run: { executable: "/mock/npm", args: ["update"] },
};
const done = { exitCode: 0, stdout: "mocked update completed", stderr: "" };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function completed(manager: EngineUpdateOperations) {
  await vi.waitFor(async () =>
    expect((await manager.read()).codex?.status).toBe("succeeded")
  );
}

describe("engine update settings persistence in isolated Postgres", () => {
  it("serializes transactions with the advisory lock and reloads committed snapshots through a new store", async () => {
    const firstStore = engineOperationStore(pool);
    const runner = vi.fn(async () => done);
    const manager = new EngineUpdateOperations(firstStore, {
      prepare: async () => installation,
      runner: () => runner,
    });
    const started = await manager.start("codex", {});
    await completed(manager);
    expect(runner).toHaveBeenCalledOnce();
    const entered = barrier();
    const release = barrier();
    const first = firstStore.exclusive(async (records) => {
      records.codex!.output = "first committed snapshot";
      entered.release();
      await release.promise;
    });
    await entered.promise;
    let secondEntered = false;
    const secondStore = engineOperationStore(pool);
    const second = secondStore.exclusive(async (records) => {
      secondEntered = true;
      expect(records.codex?.output).toBe("first committed snapshot");
      records.codex!.output += " then second snapshot";
    });
    try {
      // Prove a separate backend is actually waiting on our lock in Postgres,
      // rather than merely asserting an in-memory promise scheduling order.
      await vi.waitFor(async () => {
        const locks = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
             AND classid = 1852271177 AND objid = 1 AND NOT granted
           ) AS waiting`
        );
        expect(locks.rows[0]?.waiting).toBe(true);
      });
      expect(secondEntered).toBe(false);
    } finally {
      release.release();
      await Promise.all([first, second]);
    }
    const reloaded = new EngineUpdateOperations(engineOperationStore(pool));
    expect((await reloaded.read()).codex).toMatchObject({
      id: started.id,
      status: "succeeded",
      retryBlocked: false,
      output: "first committed snapshot then second snapshot",
    });
    const persisted = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'engine_update_operations'"
    );
    expect(JSON.parse(persisted.rows[0]!.value).codex.id).toBe(started.id);
  });

  it("atomically excludes concurrent starts and persists the result after the command settles", async () => {
    const completion = barrier();
    const runner = vi.fn(async () => {
      await completion.promise;
      return done;
    });
    const manager = new EngineUpdateOperations(engineOperationStore(pool), {
      prepare: async () => installation,
      runner: () => runner,
    });
    const results = await Promise.allSettled([
      manager.start("codex", {}),
      manager.start("codex", {}),
    ]);
    try {
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
      expect((await manager.read()).codex?.status).toBe("running");
    } finally {
      completion.release();
      await completed(manager);
    }
    const reloaded = new EngineUpdateOperations(engineOperationStore(pool));
    expect((await reloaded.read()).codex).toMatchObject({
      status: "succeeded",
      output: expect.stringContaining(done.stdout),
    });
  });

  it("rolls back a failed snapshot transaction without overwriting the durable result", async () => {
    const storage = engineOperationStore(pool);
    const manager = new EngineUpdateOperations(storage, {
      prepare: async () => installation,
      runner: () => async () => done,
    });
    await manager.start("codex", {});
    await completed(manager);
    await expect(
      storage.exclusive(async (records) => {
        records.codex!.output = "must roll back";
        throw new Error("snapshot failed");
      })
    ).rejects.toThrow("snapshot failed");
    expect(
      (await new EngineUpdateOperations(engineOperationStore(pool)).read())
        .codex?.output
    ).toContain(done.stdout);
  });
});
