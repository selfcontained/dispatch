import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  RecoveryCoordinator,
  type RecoveryEffects,
} from "../src/update-recovery/coordinator.js";
import { RecoveryStore } from "../src/update-recovery/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-coordinator-"));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  const database = path.join(root, "database");
  await writeFile(runtime, "previous", { mode: 0o700 });
  await writeFile(database, "snapshot", { mode: 0o600 });
  const store = await RecoveryStore.open(path.join(root, "recovery"));
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const transaction = await store.begin({
    instanceId: "owned",
    previous: { version: "1", sha256: hash("previous") },
    target: { version: "2", sha256: hash("target") },
    wasRunning: true,
  });
  const events: string[] = [];
  const effects: RecoveryEffects = {
    stopAndFence: vi.fn(async () => {
      events.push("stop");
    }),
    checkpoint: vi.fn(async (tx) => {
      events.push("backup");
      return store.checkpoint(tx.id, {
        files: [
          { role: "runtime", source: runtime },
          { role: "database", source: database },
        ],
        verifyDatabaseRestore: async ({ databaseFiles }) => {
          expect(await readFile(databaseFiles[0], "utf8")).toBe("snapshot");
        },
      });
    }),
    activate: vi.fn(async () => {
      events.push("activate");
    }),
    startTrial: vi.fn(async () => {
      events.push("trial");
    }),
    proveReady: vi.fn(async () => {
      events.push("ready");
    }),
    restore: vi.fn(async () => {
      events.push("restore");
    }),
    startRestoredTrial: vi.fn(async () => {
      events.push("restored-trial");
    }),
    proveRestoredReady: vi.fn(async () => {
      events.push("restored-ready");
    }),
    startNormal: vi.fn(async (tx) => {
      events.push(`normal:${tx.phase}`);
    }),
  };
  return {
    store,
    transaction,
    effects,
    events,
    coordinator: new RecoveryCoordinator(store, effects),
  };
}
it("commits only after verified backup and trial readiness", async () => {
  const f = await fixture();
  expect((await f.coordinator.apply(f.transaction.id)).phase).toBe("committed");
  expect(f.events).toEqual([
    "stop",
    "backup",
    "activate",
    "trial",
    "ready",
    "normal:committed",
  ]);
});
it.each(["activate", "startTrial", "proveReady"] as const)(
  "restores matching snapshot when %s fails",
  async (effect) => {
    const f = await fixture();
    f.effects[effect] = vi.fn(async () => {
      throw new Error("failure");
    });
    expect((await f.coordinator.apply(f.transaction.id)).phase).toBe(
      "rolled-back"
    );
    expect(f.effects.restore).toHaveBeenCalledOnce();
    expect(f.events.at(-1)).toBe("normal:rolled-back");
  }
);
it("does not rewind committed data when normal startup fails", async () => {
  const f = await fixture();
  f.effects.startNormal = vi.fn(async () => {
    throw new Error("startup failure");
  });
  await expect(f.coordinator.apply(f.transaction.id)).rejects.toThrow(
    "startup failure"
  );
  expect((await f.store.read(f.transaction.id)).phase).toBe("committed");
  expect(f.effects.restore).not.toHaveBeenCalled();
});
it("never admits normal writes when the restored previous version fails readiness", async () => {
  const f = await fixture();
  f.effects.proveReady = vi.fn(async () => {
    throw new Error("target failed");
  });
  f.effects.proveRestoredReady = vi.fn(async () => {
    throw new Error("old version failed");
  });
  await expect(f.coordinator.apply(f.transaction.id)).rejects.toThrow(
    "remains fenced"
  );
  expect((await f.store.read(f.transaction.id)).phase).toBe(
    "recovery-required"
  );
  expect(f.effects.startNormal).not.toHaveBeenCalled();
});
it("keeps recovery fenced on restore failure and retries through a new helper", async () => {
  const f = await fixture();
  f.effects.proveReady = vi.fn(async () => {
    throw new Error("target failure");
  });
  f.effects.restore = vi.fn(async () => {
    throw new Error("restore failure");
  });
  await expect(f.coordinator.apply(f.transaction.id)).rejects.toThrow(
    "remains fenced"
  );
  expect((await f.store.read(f.transaction.id)).phase).toBe(
    "recovery-required"
  );
  expect(f.effects.startNormal).not.toHaveBeenCalled();
  f.effects.restore = vi.fn(async () => {});
  expect(
    (await new RecoveryCoordinator(f.store, f.effects).resume(f.transaction.id))
      .phase
  ).toBe("rolled-back");
});
it("aborts interrupted preparation without restoring or replacing original data", async () => {
  const f = await fixture();
  expect((await f.coordinator.resume(f.transaction.id)).phase).toBe("aborted");
  expect(f.effects.restore).not.toHaveBeenCalled();
  expect(f.effects.activate).not.toHaveBeenCalled();
});
it("rolls back a reboot during probation before admitting normal work", async () => {
  const f = await fixture();
  await f.effects.checkpoint(f.transaction);
  await f.store.transition(f.transaction.id, "backed-up", "activating");
  await f.store.transition(f.transaction.id, "activating", "probation");
  f.events.length = 0;
  await f.coordinator.resume(f.transaction.id);
  expect(f.events).toEqual([
    "stop",
    "restore",
    "restored-trial",
    "restored-ready",
    "normal:rolled-back",
  ]);
  expect(f.effects.proveReady).not.toHaveBeenCalled();
});
