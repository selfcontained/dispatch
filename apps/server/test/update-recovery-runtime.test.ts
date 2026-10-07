import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createUpdateRecoveryRuntime } from "../src/server/update-recovery-runtime.js";
import { takeResumeReceipt } from "../src/update-recovery/resume-receipt.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it("retains successfully stopped host intent when another host refuses to quiesce", async () => {
  const root = await mkdtemp("/tmp/dispatch-partial-fence-");
  roots.push(root);
  vi.stubEnv("DISPATCH_STATE_DIR", root);
  const agents = [{ id: "agt_stopped", updatedAt: "2026-01-01 00:00:00+00" }];
  const manager = {
    listAgents: vi.fn(async () => []),
    recoveryHostActivity: vi.fn(async () => ({ busy: [], unattached: [] })),
    stopIdleHostsForRecovery: vi.fn(async () => ({
      stopped: ["agt_stopped"],
      remaining: ["agt_remaining"],
    })),
    updateResumeSnapshot: vi.fn(async () => agents),
  };
  const runtime = createUpdateRecoveryRuntime({
    pool: { query: vi.fn(async () => ({ rows: [{ count: 0 }] })) } as never,
    agentManager: manager as never,
    streamService: { inFlightDeliveryCount: 0 },
    releaseRuntime: { hasActiveCreateJob: () => false },
    config: { port: 12345, filesRoot: root, agentStateRoot: root },
    serverDir: root,
    version: "1.0.1",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    stopWriters: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  });
  const transactionId = "3f0e1c52-4d4b-4b7e-9b61-5a7f8a2f0c11";
  const result = await runtime.maintenance.fence({ transactionId });
  expect(result).toMatchObject({
    ok: false,
    code: "HOSTS_NOT_QUIESCED",
    reasons: [{ kind: "host-still-running", agentId: "agt_remaining" }],
  });
  expect(
    await takeResumeReceipt(
      path.join(root, "update-recovery/resume-hosts.json")
    )
  ).toMatchObject({ status: "ok", receipt: { transactionId, agents } });
});
