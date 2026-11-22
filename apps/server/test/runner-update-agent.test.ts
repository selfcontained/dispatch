import type {
  UpdateServiceFrame,
  UpdateStatusFrame,
} from "@dispatch/runner-protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateAdmission } from "../src/agents/remote/update-admission.js";
import {
  createRunnerUpdateAgent,
  PRE_ACTIVATION_FENCE_TTL_MS,
  systemdRunnerUpdater,
  type RunnerUpdater,
  readStageRecord,
  stageResult,
  type HandoffInventory,
  type StageReport,
} from "../src/agents/remote/update-agent.js";
import type { TrialRecord } from "../src/agents/remote/update-trial.js";
import { RUNNER_UPDATE_LAYOUT } from "../src/agents/remote/update-verify.js";
import {
  attemptId,
  fenceRecord,
  compatible,
  identity,
  memoryStore,
  mockUpdater,
  target,
} from "./runner-update-fixtures.js";

const otherAttempt = "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
const host = {
  sessionId: "agt_one",
  instanceId: "00000000-0000-4000-8000-000000000001",
  build: { version: "1.7.28", revision: "1".repeat(40) },
};

async function setup(
  options: {
    report?: StageReport;
    inventory?: HandoffInventory;
    store?: ReturnType<typeof memoryStore>;
    updater?: RunnerUpdater;
    installed?: typeof identity;
  } = {}
) {
  const store = options.store ?? memoryStore();
  const log = vi.fn();
  const admission = await UpdateAdmission.load(store, { log });
  const updater = mockUpdater(options.report);
  const inspect = vi.fn(
    async (): Promise<HandoffInventory> =>
      options.inventory ?? {
        retained: [host],
        requiresQuiescence: false,
        live: 1,
      }
  );
  const agent = createRunnerUpdateAgent({
    identity: options.installed ?? identity,
    admission,
    updater: options.updater ?? updater,
    inspect,
    log,
  });
  const sent: UpdateStatusFrame[] = [];
  const connection = agent.connect((frame) => sent.push(frame));
  const receive = (frame: UpdateServiceFrame) => connection.receive(frame);
  const last = () => sent[sent.length - 1];
  return {
    store,
    admission,
    updater,
    inspect,
    agent,
    sent,
    receive,
    last,
    connection,
    log,
  };
}

const offer = (retry = false, attempt = attemptId) =>
  ({ type: "update_offer", attemptId: attempt, target, retry }) as const;
const fence = (retainSessions = true, attempt = attemptId) =>
  ({ type: "update_fence", attemptId: attempt, retainSessions }) as const;

async function staged(s: Awaited<ReturnType<typeof setup>>) {
  await s.receive(offer());
  await vi.waitFor(() => expect(s.last()?.reason).toBe("ready"));
}

describe("runner update agent", () => {
  afterEach(() => vi.useRealTimers());
  it("stages the offered tuple and binds its result to the digest", async () => {
    const s = await setup();
    await s.receive(offer());
    expect(s.sent[0]).toEqual({
      type: "update_status",
      attemptId,
      phase: "deferred",
      reason: "staging",
      installed: {
        version: identity.version,
        revision: identity.revision,
        sha256: identity.sha256,
      },
    });
    expect(s.updater.stage).toHaveBeenCalledWith(target);
    await vi.waitFor(() => expect(s.last()?.reason).toBe("ready"));
    // A repeated offer reports the same result without staging again.
    await s.receive(offer());
    expect(s.last()?.reason).toBe("ready");
    expect(s.updater.stage).toHaveBeenCalledOnce();
  });

  it.each([
    [{ outcome: "refused", reason: "downgrade" } as const, "downgrade"],
    [{ outcome: "refused", reason: "version_conflict" } as const, "downgrade"],
    [{ outcome: "refused", reason: "verify_failed" } as const, "verify_failed"],
    [
      { outcome: "refused", reason: "download_failed" } as const,
      "verify_failed",
    ],
  ])("reports a refused stage %o as %s", async (report, reason) => {
    const s = await setup({ report });
    await s.receive(offer());
    await vi.waitFor(() => expect(s.last()?.reason).toBe(reason));
  });

  it.each(["downgrade", "version_conflict"])(
    "reports the floor with a %s refusal, its replay and a fence request",
    async (reason) => {
      const s = await setup({
        report: { outcome: "refused", reason, floorVersion: "1.7.31" },
      });
      const refused = { reason: "downgrade", floorVersion: "1.7.31" };
      await s.receive(offer());
      await vi.waitFor(() => expect(s.last()).toMatchObject(refused));
      for (const frame of [offer(), fence()]) {
        s.sent.length = 0;
        await s.receive(frame);
        expect(s.last()).toMatchObject(refused);
      }
    }
  );

  it("refuses a probe for another revision", () => {
    expect(
      stageResult(
        {
          outcome: "staged",
          compatibility: {
            version: target.version,
            revision: "d".repeat(40),
            handoff: { reads: [2], writes: 2 },
          },
        },
        target
      )
    ).toEqual({ reason: "verify_failed", compatibility: null });
  });

  it("answers for the installed digest and another architecture without staging", async () => {
    const s = await setup();
    await s.receive({
      type: "update_offer",
      attemptId,
      target: { ...target, sha256: identity.sha256 },
      retry: false,
    });
    expect(s.last()?.phase).toBe("confirmed");
    await s.receive({
      type: "update_offer",
      attemptId: otherAttempt,
      target: { ...target, arch: "arm64" },
      retry: false,
    });
    expect(s.last()).toMatchObject({
      attemptId: otherAttempt,
      reason: "verify_failed",
    });
    expect(s.updater.stage).not.toHaveBeenCalled();
  });

  it("suppresses a failed digest unless the offer is an explicit retry", async () => {
    const s = await setup();
    s.updater.suppressed.mockResolvedValue(true);
    await s.receive(offer());
    expect(s.last()?.reason).toBe("suppressed");
    expect(s.updater.stage).not.toHaveBeenCalled();
    await s.receive(offer(true));
    expect(s.updater.stage).toHaveBeenCalledOnce();
  });

  it("does not advance an attempt with a different digest or attempt ID", async () => {
    const s = await setup();
    await staged(s);
    await s.receive({
      type: "update_offer",
      attemptId,
      target: { ...target, sha256: "e".repeat(64) },
      retry: false,
    });
    expect(s.last()).toMatchObject({ attemptId, reason: "cancelled" });
    await s.receive(fence(true, otherAttempt));
    expect(s.last()).toMatchObject({
      attemptId: otherAttempt,
      reason: "cancelled",
    });
    expect(s.admission.closed).toBe(false);
    await s.receive({ type: "update_activate", attemptId });
    expect(s.updater.activate).not.toHaveBeenCalled();
    // The original attempt still fences.
    await s.receive(fence());
    expect(s.last()?.reason).toBe("fence_ready");
  });

  it("does not fence before staging is ready", async () => {
    const s = await setup();
    s.updater.stage.mockReturnValue(new Promise(() => {}));
    await s.receive(offer());
    await s.receive(fence());
    expect(s.last()?.reason).toBe("staging");
    expect(s.admission.closed).toBe(false);
  });

  it("fences and reports the authoritative retained set", async () => {
    const s = await setup();
    await staged(s);
    await s.receive(fence());
    expect(s.inspect).toHaveBeenCalledWith({ reads: [1, 2], writes: 2 });
    expect(s.last()).toMatchObject({
      phase: "deferred",
      reason: "fence_ready",
      retained: [{ sessionId: host.sessionId, instanceId: host.instanceId }],
      requiresQuiescence: false,
    });
    expect(s.last()?.retained?.[0]).not.toHaveProperty("build");
    expect(s.admission.closed).toBe(true);
    expect(s.store.record).toMatchObject({
      attemptId,
      phase: "fenced",
      startedAt: expect.any(Number),
      retained: [{ sessionId: host.sessionId, instanceId: host.instanceId }],
    });
    expect(s.agent.advert()?.pendingAttemptId).toBe(attemptId);
  });

  it("leaves terminals open when admitted operations time out", async () => {
    const s = await setup();
    await staged(s);
    vi.useFakeTimers();
    const terminal = vi.fn();
    s.admission.onTerminal(terminal);
    s.admission.admit(1_000);
    const pending = s.receive(fence());
    await vi.advanceTimersByTimeAsync(6_001);
    await pending;
    expect(s.last()?.reason).toBe("operations_pending");
    expect(terminal).not.toHaveBeenCalled();
  });

  it("keeps terminals open, reopens and asks for quiescence when live handoff is unsafe", async () => {
    const s = await setup({
      inventory: { retained: [host], requiresQuiescence: true, live: 2 },
    });
    const terminal = vi.fn();
    s.admission.onTerminal(terminal);
    await staged(s);
    vi.useFakeTimers();
    const inventory = await s.inspect();
    s.inspect.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return inventory;
    });
    const pending = s.receive(fence());
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(s.last()).toMatchObject({
      reason: "incompatible_handoff",
      requiresQuiescence: true,
    });
    expect(s.admission.closed).toBe(false);
    expect(s.store.record).toBeNull();
    expect(terminal).not.toHaveBeenCalled();
  });

  it("uses no candidate formats when the probe failed", async () => {
    const s = await setup({
      report: { outcome: "staged", compatibility: null },
    });
    await staged(s);
    await s.receive(fence());
    expect(s.inspect).toHaveBeenCalledWith(null);
  });

  it("requires an empty boundary when sessions are not retained", async () => {
    const s = await setup();
    await staged(s);
    await s.receive(fence(false));
    expect(s.last()).toMatchObject({ reason: "operations_pending" });
    expect(s.admission.closed).toBe(false);

    const empty = await setup({
      inventory: { retained: [], requiresQuiescence: true, live: 0 },
    });
    await staged(empty);
    await empty.receive(fence(false));
    expect(empty.last()).toMatchObject({ reason: "fence_ready", retained: [] });
    expect(empty.admission.closed).toBe(true);
  });

  it("cancel before activation releases the fence", async () => {
    const s = await setup();
    await staged(s);
    await s.receive(fence());
    await s.receive({
      type: "update_cancel",
      attemptId: otherAttempt,
      reason: "policy_changed",
    });
    expect(s.admission.closed).toBe(true);
    await s.receive({
      type: "update_cancel",
      attemptId,
      reason: "policy_changed",
    });
    expect(s.last()).toMatchObject({ attemptId, reason: "cancelled" });
    expect(s.admission.closed).toBe(false);
    expect(s.store.record).toBeNull();
    expect(s.agent.advert()).not.toHaveProperty("pendingAttemptId");
  });

  it("activates only a fenced attempt and confirms only its exact build", async () => {
    const s = await setup();
    await staged(s);
    await s.receive({ type: "update_activate", attemptId });
    expect(s.updater.activate).not.toHaveBeenCalled();
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId: otherAttempt });
    expect(s.updater.activate).not.toHaveBeenCalled();
    expect(s.store.record?.phase).toBe("fenced");
    await s.receive({ type: "update_activate", attemptId });
    expect(s.last()?.phase).toBe("activating");
    expect(s.store.record?.phase).toBe("activating");
    expect(s.updater.activate).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId, phase: "activating" })
    );
    for (const wrong of [
      { revision: "d".repeat(40), sha256: target.sha256 },
      { revision: target.revision, sha256: "e".repeat(64) },
    ]) {
      await s.receive({ type: "update_confirm", attemptId, ...wrong });
      expect(s.last()?.phase).toBe("activating");
    }
    await s.receive({
      type: "update_confirm",
      attemptId: otherAttempt,
      revision: target.revision,
      sha256: target.sha256,
    });
    expect(s.updater.confirm).not.toHaveBeenCalled();
    expect(s.admission.closed).toBe(true);
    await s.receive({
      type: "update_confirm",
      attemptId,
      revision: target.revision,
      sha256: target.sha256,
    });
    expect(s.updater.confirm).toHaveBeenCalledOnce();
    expect(s.last()?.phase).toBe("confirmed");
    expect(s.admission.closed).toBe(false);
  });

  it("does not activate or re-fence while admitted work drains", async () => {
    const s = await setup();
    await staged(s);
    const ticket = s.admission.admit(60_000)!;
    void s.receive(fence());
    await vi.waitFor(() => expect(s.store.record?.phase).toBe("fencing"));
    await s.receive({ type: "update_activate", attemptId });
    await s.receive(fence());
    expect(s.updater.activate).not.toHaveBeenCalled();
    expect(s.inspect).not.toHaveBeenCalled();
    expect(s.last()?.reason).toBe("ready");
    ticket.release();
    await vi.waitFor(() => expect(s.last()?.reason).toBe("fence_ready"));
    expect(s.inspect).toHaveBeenCalledOnce();
  });

  it("hands a cancel during activation to the updater", async () => {
    const s = await setup();
    await staged(s);
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId });
    await s.receive({
      type: "update_cancel",
      attemptId,
      reason: "trial_failed",
    });
    expect(s.updater.cancelTrial).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId }),
      "trial_failed"
    );
    expect(s.admission.closed).toBe(true);
  });

  it("reopens when the updater refuses activation before any swap", async () => {
    const s = await setup();
    s.updater.activate.mockRejectedValue(new Error("not available"));
    await staged(s);
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId });
    expect(s.last()).toMatchObject({ phase: "deferred", reason: "cancelled" });
    expect(s.admission.closed).toBe(false);
  });

  const cancel = (id = attemptId) =>
    ({
      type: "update_cancel",
      attemptId: id,
      reason: "policy_changed",
    }) as const;

  it("clears a restarted activating record when the production updater has no trial", async () => {
    const store = memoryStore({ ...fenceRecord, phase: "activating" });
    const s = await setup({
      store,
      updater: systemdRunnerUpdater(RUNNER_UPDATE_LAYOUT),
    });
    expect(s.admission.closed).toBe(true);
    await s.receive(cancel());
    expect(s.last()).toMatchObject({
      attemptId,
      phase: "deferred",
      reason: "cancelled",
    });
    expect(store.record).toBeNull();
    expect(s.admission.closed).toBe(false);
  });

  it("defers an activation while a manual or staging writer holds the lock", async () => {
    const updater = {
      ...mockUpdater(),
      activationLocksAvailable: vi.fn(async () => false),
    };
    const s = await setup({ updater });
    await staged(s);
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId });
    expect(updater.activate).not.toHaveBeenCalled();
    expect(updater.activationLocksAvailable).toHaveBeenCalledOnce();
    expect(s.store.write.mock.calls.map(([record]) => record.phase)).toEqual([
      "fencing",
      "fenced",
    ]);
    expect(s.store.record).toBeNull();
    expect(s.last()).toMatchObject({
      phase: "deferred",
      reason: "operations_pending",
    });
    await s.receive(offer());
    await vi.waitFor(() => expect(s.last()?.reason).toBe("ready"));
  });

  it("does not persist activating when activation is unavailable", async () => {
    const updater = { ...mockUpdater(), canActivate: false };
    const s = await setup({ updater });
    await staged(s);
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId });
    expect(updater.activate).not.toHaveBeenCalled();
    expect(s.store.write.mock.calls.map(([record]) => record.phase)).toEqual([
      "fencing",
      "fenced",
    ]);
    expect(s.last()).toMatchObject({ phase: "deferred", reason: "cancelled" });
    expect(s.admission.closed).toBe(false);
  });

  it("advertises an unreadable fence and accepts a cancel with any attempt ID", async () => {
    const store = memoryStore();
    store.read.mockRejectedValueOnce(new Error("malformed fence"));
    const s = await setup({ store });
    expect(s.agent.advert()).toMatchObject({ fenceUnreadable: true });
    expect(s.agent.advert()).not.toHaveProperty("pendingAttemptId");
    expect(s.admission.closed).toBe(true);
    await s.receive(cancel(otherAttempt));
    expect(s.last()).toMatchObject({
      attemptId: otherAttempt,
      reason: "cancelled",
    });
    expect(s.agent.advert()).not.toHaveProperty("fenceUnreadable");
    expect(s.admission.closed).toBe(false);
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it("reopens and logs a fence clear failure while still reporting cancellation", async () => {
    const s = await setup();
    await staged(s);
    await s.receive(fence());
    s.store.clear.mockRejectedValueOnce(new Error("fixture clear failure"));
    await s.receive(cancel());
    expect(s.admission.closed).toBe(false);
    expect(s.last()).toMatchObject({ reason: "cancelled" });
    expect(s.log).toHaveBeenCalledWith(
      expect.stringContaining("fixture clear failure")
    );
  });

  it("expires a disconnected pre-activation fence and reports cancellation on reconnect", async () => {
    const s = await setup();
    await staged(s);
    vi.useFakeTimers();
    await s.receive(fence());
    s.connection.close();
    await vi.advanceTimersByTimeAsync(PRE_ACTIVATION_FENCE_TTL_MS - 1);
    expect(s.admission.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.store.record).toBeNull();
    expect(s.admission.closed).toBe(false);
    expect(s.last()?.reason).toBe("fence_ready");
    s.agent.connect((frame) => s.sent.push(frame));
    expect(s.last()).toMatchObject({
      attemptId,
      phase: "deferred",
      reason: "cancelled",
    });
  });

  it("uses the persisted TTL after restart", async () => {
    vi.useFakeTimers();
    const store = memoryStore({
      ...fenceRecord,
      phase: "fenced",
      startedAt: Date.now() - PRE_ACTIVATION_FENCE_TTL_MS + 100,
    });
    const s = await setup({ store });
    await vi.advanceTimersByTimeAsync(99);
    expect(s.admission.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.admission.closed).toBe(false);
    expect(s.last()).toMatchObject({
      attemptId,
      phase: "deferred",
      reason: "cancelled",
    });
  });

  it("keeps activation fenced after the pre-activation deadline", async () => {
    const s = await setup();
    await staged(s);
    vi.useFakeTimers();
    await s.receive(fence());
    await s.receive({ type: "update_activate", attemptId });
    await vi.advanceTimersByTimeAsync(PRE_ACTIVATION_FENCE_TTL_MS);
    expect(s.store.record?.phase).toBe("activating");
    expect(s.admission.closed).toBe(true);
  });

  it("a restarted supervisor keeps its persisted fence and replays it", async () => {
    const store = memoryStore({
      format: 1,
      attemptId,
      target,
      retainSessions: true,
      phase: "fenced",
      startedAt: Date.now(),
      retained: [{ sessionId: host.sessionId, instanceId: host.instanceId }],
    });
    const s = await setup({ store });
    expect(s.admission.closed).toBe(true);
    expect(s.agent.advert()?.pendingAttemptId).toBe(attemptId);
    await s.receive(offer(false, otherAttempt));
    expect(s.last()).toMatchObject({
      attemptId: otherAttempt,
      reason: "cancelled",
    });
    await s.receive(offer());
    expect(s.last()).toMatchObject({ attemptId, reason: "fence_ready" });
    await vi.waitFor(() => expect(s.updater.stage).toHaveBeenCalledOnce());
    // The fence never reopened and re-inspects once staging is rebound.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.receive(fence());
    expect(s.inspect).toHaveBeenCalled();
    expect(s.last()).toMatchObject({ reason: "fence_ready" });
    expect(s.admission.closed).toBe(true);
  });

  it("stops sending to a connection once it closes", async () => {
    const s = await setup();
    let finish!: (report: StageReport) => void;
    s.updater.stage.mockReturnValue(
      new Promise((resolve) => (finish = resolve))
    );
    const closing: UpdateStatusFrame[] = [];
    const connection = s.agent.connect((frame) => closing.push(frame));
    await connection.receive(offer());
    connection.close();
    finish(compatible);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closing.map((frame) => frame.reason)).toEqual(["staging"]);
  });

  it("sends statuses only on the latest connection", async () => {
    const s = await setup();
    const older: UpdateStatusFrame[] = [];
    const first = s.agent.connect((frame) => older.push(frame));
    const second: UpdateStatusFrame[] = [];
    const latest = s.agent.connect((frame) => second.push(frame));
    first.close();
    await latest.receive(offer());
    expect(older).toEqual([]);
    expect(second[0]?.reason).toBe("staging");
  });

  it("does nothing without an advertised identity", async () => {
    const admission = await UpdateAdmission.load(memoryStore());
    const updater = mockUpdater();
    const agent = createRunnerUpdateAgent({
      identity: null,
      admission,
      updater,
      inspect: vi.fn(),
    });
    const sent: UpdateStatusFrame[] = [];
    await agent.connect((frame) => sent.push(frame)).receive(offer());
    expect(agent.advert()).toBeUndefined();
    expect(sent).toEqual([]);
    expect(updater.stage).not.toHaveBeenCalled();
  });
});

describe("staging record", () => {
  let root: string | undefined;
  afterEach(() =>
    root ? rm(root, { recursive: true, force: true }) : undefined
  );

  it("binds the record to the offered digest and this run", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-stage-record-"));
    const state = path.join(root, "state");
    await mkdir(state, { mode: 0o700 });
    const layout = {
      config: "",
      installed: "",
      staging: "",
      state,
    };
    const uid = process.getuid!();
    const write = (record: object) =>
      writeFile(path.join(state, "last-stage.json"), JSON.stringify(record), {
        mode: 0o600,
      });
    const now = Date.now();
    const { revision: _revision, ...named } = target;
    await write({
      outcome: "staged",
      target: named,
      compatibility:
        compatible.outcome === "staged" && compatible.compatibility,
      at: new Date(now).toISOString(),
    });
    expect(await readStageRecord(layout, target, now, uid)).toEqual(compatible);
    // Another digest, or an older run, is not this result.
    expect(
      await readStageRecord(
        layout,
        { ...target, sha256: "e".repeat(64) },
        now,
        uid
      )
    ).toBeNull();
    expect(await readStageRecord(layout, target, now + 60_000, uid)).toBeNull();
    await write({
      outcome: "refused",
      reason: "downgrade",
      target: named,
      at: new Date(now).toISOString(),
    });
    expect(await readStageRecord(layout, target, now, uid)).toEqual({
      outcome: "refused",
      reason: "downgrade",
    });
    for (const [floorVersion, expected] of [
      ["1.7.31", { floorVersion: "1.7.31" }],
      ["latest", {}],
      [`1.7.${"1".repeat(64)}`, {}],
    ] as const) {
      await write({
        outcome: "refused",
        reason: "downgrade",
        floorVersion,
        target: named,
        at: new Date(now).toISOString(),
      });
      expect(await readStageRecord(layout, target, now, uid)).toEqual({
        outcome: "refused",
        reason: "downgrade",
        ...expected,
      });
    }
    await write({
      outcome: "refused",
      reason: "downgrade",
      at: new Date(now).toISOString(),
    });
    expect(await readStageRecord(layout, target, now, uid)).toBeNull();
  });
});

describe("durable trial protocol", () => {
  afterEach(() => vi.useRealTimers());

  async function trial(inventory?: HandoffInventory) {
    vi.useFakeTimers();
    const fence = {
      ...fenceRecord,
      phase: "activating",
      retained: [host],
    } as const;
    const store = memoryStore({
      ...fence,
      retained: [{ sessionId: host.sessionId, instanceId: host.instanceId }],
    });
    let record: TrialRecord = {
      fence: store.record!,
      phase: "trial",
      previous: identity,
      deadline: Date.now() + 60_000,
    };
    const updater = {
      ...mockUpdater(),
      durable: {
        read: vi.fn(async () => record),
        fenceCleared: async () => store.record === null,
        signal: vi.fn(async () => {}),
      },
    } satisfies RunnerUpdater;
    const s = await setup({
      store,
      updater,
      inventory,
      installed: { ...identity, ...target },
    });
    await vi.advanceTimersByTimeAsync(1);
    const confirm = (revision = target.revision, attempt = attemptId) =>
      s.receive({
        type: "update_confirm",
        attemptId: attempt,
        revision,
        sha256: target.sha256,
      });
    return {
      ...s,
      updater,
      confirm,
      setRecord: (next: TrialRecord) => {
        record = next;
      },
    };
  }

  it("reports the trial and keeps admission closed until the durable terminal is published and cleared", async () => {
    const s = await trial();
    expect(s.last()).toMatchObject({
      attemptId,
      phase: "activating",
      reason: "trial",
      installed: { revision: target.revision, sha256: target.sha256 },
      retained: [{ sessionId: host.sessionId, instanceId: host.instanceId }],
    });
    await s.confirm();
    expect(s.updater.confirm).toHaveBeenCalledOnce();
    expect(s.admission.closed).toBe(true);
    s.setRecord({ fence: s.store.record!, phase: "confirmed" });
    await vi.advanceTimersByTimeAsync(500);
    expect(s.admission.closed).toBe(true);
    s.store.record = null;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.admission.closed).toBe(false);
    expect(s.last()).toMatchObject({ phase: "confirmed" });
    expect(s.store.clear).not.toHaveBeenCalled();
    await s.confirm();
    expect(s.last()).toMatchObject({ phase: "confirmed" });
    expect(s.updater.confirm).toHaveBeenCalledOnce();
  });

  it("rejects a mismatching revision for the active attempt, ignoring an unrelated attempt", async () => {
    const s = await trial();
    await s.confirm(target.revision, otherAttempt);
    expect(s.updater.durable.signal).not.toHaveBeenCalled();
    await s.confirm("e".repeat(40));
    expect(s.updater.durable.signal).toHaveBeenCalledWith(s.store.record, {
      kind: "reject",
      reason: "verify_failed",
    });
    expect(s.updater.confirm).not.toHaveBeenCalled();
  });

  it("rejects a retained session replaced by a different instance", async () => {
    const s = await trial({
      retained: [
        { ...host, instanceId: "00000000-0000-4000-8000-000000000002" },
      ],
      requiresQuiescence: false,
      live: 1,
    });
    await s.confirm();
    expect(s.updater.durable.signal).toHaveBeenCalledWith(s.store.record, {
      kind: "reject",
      reason: "reattach_failed",
    });
    expect(s.updater.confirm).not.toHaveBeenCalled();
  });
});
