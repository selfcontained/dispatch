import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ContextTransferCoordinator } from "../src/agents/context-transfer/coordinator.js";
import { PgTransferLedger } from "../src/agents/context-transfer/store.js";
import {
  TransferConflict,
  type TransferRecord,
} from "../src/agents/context-transfer/types.js";
import { now, transferFixture } from "./helpers/context-transfer-fixture.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let ledger: PgTransferLedger;
const controller = (store = ledger) =>
  new ContextTransferCoordinator(store, { enabled: true, now: () => now });
async function prepare(c = controller()) {
  const r = transferFixture();
  return c.prepare(r, { identity: r.handoff.identity, boundary: 7 });
}
async function reserved() {
  const row = await prepare();
  return controller().reserveLaunch(row.transferId, {
    identity: row.request.budget.identity,
    boundary: 7,
  });
}
async function receipted() {
  const row = await reserved();
  return controller().recordLaunchReceipt(
    row.transferId,
    row.launchKey,
    "successor"
  );
}
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("TRUNCATE context_transfers");
  ledger = new PgTransferLedger(pool);
});

describe("dormant context transfer ledger", () => {
  it("defaults to disabled without preparing or launching anything", async () => {
    await expect(
      prepare(new ContextTransferCoordinator(ledger))
    ).rejects.toThrow("disabled");
    expect(
      (await pool.query("SELECT count(*) FROM context_transfers")).rows[0].count
    ).toBe("0");
  });
  it("prepares exactly once under concurrent duplicate events", async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => prepare()));
    expect(new Set(rows.map((r) => r.transferId)).size).toBe(1);
    expect(
      (await pool.query("SELECT count(*) FROM context_transfers")).rows[0].count
    ).toBe("1");
    expect(rows[0].request.handoff.authorizationRefs).toEqual([
      "original-user-message",
    ]);
  });
  it("rolls back an interrupted preparation transaction", async () => {
    const faultPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, args?: unknown[]) => {
            if (sql === "COMMIT") throw new Error("crash before commit");
            return client.query(sql, args);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    await expect(
      prepare(controller(new PgTransferLedger(faultPool)))
    ).rejects.toThrow("crash before commit");
    expect(
      (await pool.query("SELECT count(*) FROM context_transfers")).rows[0].count
    ).toBe("0");
    expect((await prepare()).state).toBe("prepared");
  });
  it("reconciles a committed preparation after a lost response and aged budget", async () => {
    const row = await prepare();
    const restarted = new ContextTransferCoordinator(
      new PgTransferLedger(pool),
      { enabled: true, now: () => now + 100000 }
    );
    expect((await prepare(restarted)).transferId).toBe(row.transferId);
  });
  it("rejects replay and reservation after the current boundary advances", async () => {
    const row = await prepare();
    const r = transferFixture();
    await expect(
      controller().prepare(r, { identity: r.handoff.identity, boundary: 8 })
    ).rejects.toThrow("boundary");
    await expect(
      controller().reserveLaunch(row.transferId, {
        identity: r.handoff.identity,
        boundary: 8,
      })
    ).rejects.toThrow("changed");
    expect((await ledger.get(row.transferId))?.state).toBe("prepared");
  });
  it("never rebinds an existing boundary to a new handoff or permission claim", async () => {
    await prepare();
    const r = transferFixture();
    r.handoff.sha256 = "8".repeat(64);
    await expect(
      controller().prepare(r, { identity: r.handoff.identity, boundary: 7 })
    ).rejects.toBeInstanceOf(TransferConflict);
  });
  it("enforces one attempt per chain, even after cancellation", async () => {
    const row = await prepare();
    await controller().cancel(row.transferId);
    const r = transferFixture();
    r.budget.boundary = 8;
    await expect(
      controller().prepare(r, { identity: r.handoff.identity, boundary: 8 })
    ).rejects.toThrow("already reserved");
  });
  it("serializes different transfer intents for the same workspace", async () => {
    const r = transferFixture();
    r.chainId = "second-chain";
    r.budget.identity.agentId = "another";
    r.handoff.identity.agentId = "another";
    const results = await Promise.allSettled([
      prepare(),
      controller().prepare(r, { identity: r.handoff.identity, boundary: 7 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("recovers one stable launch intent after a crash without calling a launcher", async () => {
    const row = await reserved();
    const restarted = controller(new PgTransferLedger(pool));
    const again = await restarted.reserveLaunch(row.transferId, {
      identity: row.request.budget.identity,
      boundary: 7,
    });
    expect(again.launchKey).toBe(row.launchKey);
    expect(again.revision).toBe(row.revision);
    expect(again.state).toBe("launch_reserved");
    expect(again.successorAgentId).toBeNull();
  });
  it("reconciles a receipt committed before its response was lost", async () => {
    const row = await reserved();
    const original = ledger.compareAndSet.bind(ledger);
    ledger.compareAndSet = async (current, next) => {
      await original(current, next);
      throw new Error("crash after commit");
    };
    await expect(
      controller().recordLaunchReceipt(
        row.transferId,
        row.launchKey,
        "successor"
      )
    ).rejects.toThrow("crash after commit");
    const recovered = await controller(
      new PgTransferLedger(pool)
    ).recordLaunchReceipt(row.transferId, row.launchKey, "successor");
    expect(recovered.state).toBe("receipt_recorded");
    expect(recovered.revision).toBe(2);
  });
  it("refuses a second successor and a forged receipt key", async () => {
    const row = await receipted();
    await expect(
      controller().recordLaunchReceipt(row.transferId, row.launchKey, "other")
    ).rejects.toThrow("Reconcile");
    await expect(
      controller().recordLaunchReceipt(row.transferId, "wrong", "successor")
    ).rejects.toThrow("Invalid");
  });
  it.each(["cwd", "branch", "head", "dirtyHash", "permissionsHash"] as const)(
    "refuses stale %s before reserving launch",
    async (key) => {
      const row = await prepare();
      const identity = structuredClone(row.request.budget.identity);
      identity[key] = key.endsWith("Hash")
        ? "9".repeat(64)
        : key === "head"
          ? "9".repeat(40)
          : "/different";
      await expect(
        controller().reserveLaunch(row.transferId, { identity, boundary: 7 })
      ).rejects.toThrow("changed");
      expect((await ledger.get(row.transferId))?.state).toBe("prepared");
    }
  );
  it("pickup verification cannot activate a writer", async () => {
    const row = await receipted();
    const pickup = {
      successorAgentId: "successor",
      handoffHash: row.request.handoff.sha256,
      handoffIdentity: row.request.handoff.identity,
    };
    const verified = await controller().verifyPickup(row.transferId, pickup);
    expect(verified.state).toBe("pickup_verified");
    expect(
      (await controller().verifyPickup(row.transferId, pickup)).revision
    ).toBe(verified.revision);
    await expect(
      pool.query(
        "UPDATE context_transfers SET state='active' WHERE transfer_id=$1",
        [row.transferId]
      )
    ).rejects.toThrow();
  });
  it("retains failed pickup as recoverable metadata without activating", async () => {
    const row = await receipted();
    const result = await controller().verifyPickup(row.transferId, {
      successorAgentId: "successor",
      handoffHash: "0".repeat(64),
      handoffIdentity: row.request.handoff.identity,
    });
    expect(result.state).toBe("failed");
    expect(result.failureReason).toBe("pickup_mismatch");
    expect(result.successorAgentId).toBe("successor");
    await expect(
      controller().reserveLaunch(row.transferId, {
        identity: row.request.budget.identity,
        boundary: 7,
      })
    ).rejects.toThrow("terminal");
  });
  it.each([
    "prepared",
    "launch_reserved",
    "receipt_recorded",
    "pickup_verified",
  ] as const)("cancellation fences late receipts from %s", async (state) => {
    let row: TransferRecord =
      state === "prepared"
        ? await prepare()
        : state === "launch_reserved"
          ? await reserved()
          : await receipted();
    if (state === "pickup_verified")
      row = await controller().verifyPickup(row.transferId, {
        successorAgentId: "successor",
        handoffHash: row.request.handoff.sha256,
        handoffIdentity: row.request.handoff.identity,
      });
    const stopped = await new ContextTransferCoordinator(ledger).cancel(
      row.transferId
    );
    expect(stopped.state).toBe("cancelled");
    await expect(
      controller().recordLaunchReceipt(
        row.transferId,
        row.launchKey,
        "successor"
      )
    ).rejects.toThrow();
    expect((await controller().cancel(row.transferId)).revision).toBe(
      stopped.revision
    );
  });
  it("cancellation wins a race with a launch receipt", async () => {
    const row = await reserved();
    await Promise.allSettled([
      controller().recordLaunchReceipt(
        row.transferId,
        row.launchKey,
        "successor"
      ),
      controller().cancel(row.transferId),
    ]);
    expect((await ledger.get(row.transferId))?.state).toBe("cancelled");
  });
  it("CAS refuses a stale update after cancellation", async () => {
    const row = await prepare();
    await controller().cancel(row.transferId);
    expect(
      await ledger.compareAndSet(row, { state: "launch_reserved" })
    ).toBeNull();
  });
  it("does not persist unsafe or uncompacted snapshots", async () => {
    const r = transferFixture();
    r.budget.phase = "before-compaction";
    await expect(
      controller().prepare(r, { identity: r.handoff.identity, boundary: 7 })
    ).rejects.toThrow("compact");
    r.budget.phase = "after-compaction";
    r.budget.source = "unknown";
    await expect(
      controller().prepare(r, { identity: r.handoff.identity, boundary: 7 })
    ).rejects.toThrow("blocked");
    expect(
      (await pool.query("SELECT count(*) FROM context_transfers")).rows[0].count
    ).toBe("0");
  });
});
