import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileRunnerUpdateStore,
  UPDATE_HOLD_BOUND_MS,
  UPDATE_TIMING,
} from "../src/agents/remote/update-coordinator.js";
import {
  AGENT,
  build,
  INSTANCE,
  logger,
  RUNNER,
  updateWorld,
} from "./runner-update-coordinator-fixtures.js";
import { identity, target } from "./runner-update-fixtures.js";

type World = Awaited<ReturnType<typeof updateWorld>>;
let world: World;
afterEach(async () => {
  await world?.close();
});

async function online(options: Parameters<typeof updateWorld>[0] = {}) {
  world = await updateWorld(options);
  await world.start();
  await world.connect();
  return world;
}

const update = (action: "update" | "retry" = "update") =>
  world.coordinator.request(RUNNER, action);

const ineligible = (code: string) =>
  expect.objectContaining({
    code,
    status: code === "not_found" ? 404 : 409,
  });

async function staging() {
  let release!: () => void;
  world.runner.staging = new Promise((resolve) => (release = resolve));
  const { attemptId } = await update();
  await world.until(() =>
    world.runner.statuses.some((status) => status.reason === "staging")
  );
  return { attemptId, release };
}

async function settling() {
  world.hosts.reply = "socket";
  const { attemptId } = await update();
  await world.until(() => world.attempt()?.retained);
  return attemptId;
}

async function switching() {
  const { attemptId } = await update();
  await world.until(() => world.runner.trial?.phase === "prepared");
  expect(world.phase()).toBe("switching");
  return attemptId;
}

/** In trial, with a host that cannot prove itself yet. */
async function confirming() {
  const attemptId = await switching();
  world.hosts.reply = "socket";
  await world.swap();
  await world.until(() => world.phase() === "confirming");
  return attemptId;
}

async function updated() {
  await switching();
  await world.swap();
  await world.until(() => world.result()?.state === "updated");
}

async function rolledBack() {
  await switching();
  await world.swap();
  await world.rollBack("boot_failed");
  await world.until(() => world.result()?.state === "rolled_back");
}

describe("a live update", () => {
  it("offers, fences with retained sessions, activates, confirms, releases and recycles", async () => {
    await online();
    expect(world.coordinator.view(RUNNER)).toEqual({
      available: { version: target.version, action: "update" },
    });
    const { attemptId } = await update();
    await world.until(() => world.runner.trial?.phase === "prepared");
    expect(world.holds.current(RUNNER)?.attemptId).toBe(attemptId);
    expect(world.coordinator.view(RUNNER)?.attempt?.held).toBe(true);
    expect(world.agents.startRunnerHostRecycling).not.toHaveBeenCalled();
    expect(world.attempt()).toMatchObject({
      id: attemptId,
      phase: "switching",
      retained: [{ sessionId: AGENT, instanceId: INSTANCE }],
    });
    const attachesBeforeSwap = world.hosts.attaches;
    await world.swap();
    await world.until(() => world.result()?.state === "updated");

    expect(world.hosts.attaches).toBeGreaterThan(attachesBeforeSwap);
    expect(world.runner.frames.map((frame) => frame.type)).toEqual([
      "update_offer",
      "update_fence",
      "update_activate",
      // The reconnected runner answers a repeated offer with its trial.
      "update_offer",
      "update_confirm",
    ]);
    expect(world.sent("update_offer")[0]).toEqual({
      type: "update_offer",
      attemptId,
      target,
      retry: false,
    });
    expect(world.sent("update_fence")[0].retainSessions).toBe(true);
    expect(world.sent("update_confirm")[0]).toMatchObject({
      revision: target.revision,
      sha256: target.sha256,
    });
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.agents.startRunnerHostRecycling).toHaveBeenLastCalledWith({
      runnerId: RUNNER,
      attemptId,
      revision: target.revision,
      sha256: target.sha256,
    });
    expect(world.coordinator.view(RUNNER)).toEqual({
      result: { state: "updated", version: target.version },
    });
    world.agents.runnerHostRecycleProgress.mockReturnValue({
      oldBuild: 2,
      recycled: 0,
      waiting: 2,
    });
    expect(world.coordinator.view(RUNNER)?.previousBuildAgents).toBe(2);
    // The confirmed fence is no longer pending on this connection either.
    expect(world.service.selfUpdate(RUNNER)?.advert).not.toHaveProperty(
      "pendingAttemptId"
    );
  });

  it("confirms an empty retained set without any host evidence", async () => {
    await online({ agents: 0 });
    world.hosts.reply = "gone";
    await updated();
    expect(world.hosts.attaches).toBe(0);
  });

  it.each(["x64", "arm64"] as const)(
    "offers the signed artifact for a %s runner",
    async (arch) => {
      await online({ identity: { ...identity, arch } });
      await update();
      await world.until(() => world.sent("update_offer").length);
      expect(world.artifacts.getUpdate).toHaveBeenCalledWith(arch);
      expect(world.sent("update_offer")[0].target).toEqual({ ...target, arch });
    }
  );

  it("holds for longer than every phase together", () => {
    const { stagingMs, settlingMs, switchingMs, rollbackMs } = UPDATE_TIMING;
    expect(UPDATE_HOLD_BOUND_MS).toBeGreaterThan(
      stagingMs + settlingMs + switchingMs + rollbackMs
    );
  });

  it("lets work through while the runner stages", async () => {
    await online();
    const begin = vi.spyOn(world.holds, "begin");
    const { attemptId, release } = await staging();
    await world.settle();
    expect(begin).not.toHaveBeenCalled();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.admission.closed).toBe(false);
    expect(world.coordinator.view(RUNNER)?.attempt).toEqual({
      id: attemptId,
      phase: "staging",
      version: target.version,
    });
    release();
    await world.until(() => world.holds.isHeld(RUNNER));
  });

  it("begins that hold at ready, before the fence is asked for", async () => {
    await online();
    const order: string[] = [];
    const begin = world.holds.begin.bind(world.holds);
    world.holds.begin = async (...args) => {
      order.push(world.attempt()!.phase);
      const hold = await begin(...args);
      order.push("held");
      expect(Date.parse(hold.expiresAt) - Date.parse(hold.beganAt)).toBe(
        UPDATE_HOLD_BOUND_MS
      );
      return hold;
    };
    const offer = world.service.offerUpdate.bind(world.service);
    world.service.offerUpdate = (...args) => {
      order.push(world.saved.records.length ? "saved" : "unsaved", "offered");
      return offer(...args);
    };
    const fence = world.service.fenceUpdate.bind(world.service);
    world.service.fenceUpdate = (...args) => {
      order.push("fence");
      return fence(...args);
    };
    await update();
    await world.until(() => order.includes("fence"));
    expect(order).toEqual(["saved", "offered", "settling", "held", "fence"]);
  });
});

describe("requests", () => {
  it("makes one attempt of simultaneous clicks", async () => {
    await online();
    const clicks = await Promise.all([update(), update(), update("retry")]);
    expect(new Set(clicks.map((click) => click.attemptId)).size).toBe(1);
    await world.until(() => world.sent("update_offer").length);
    expect(world.sent("update_offer")).toHaveLength(1);
    expect(world.artifacts.getUpdate).toHaveBeenCalledTimes(1);
    await expect(update()).rejects.toEqual(
      expect.objectContaining({
        code: "update_in_progress",
        attemptId: clicks[0]!.attemptId,
      })
    );
  });

  it("refuses an unknown runner", async () => {
    await online();
    world.revoke();
    await expect(update()).rejects.toEqual(ineligible("not_found"));
  });

  it("refuses before boot reconciliation has run", async () => {
    world = await updateWorld();
    await world.connect();
    await expect(update()).rejects.toEqual(ineligible("not_ready"));
  });

  it("refuses an offline runner", async () => {
    await online();
    await world.disconnect();
    await expect(update()).rejects.toEqual(ineligible("offline"));
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
  });

  it("refuses and shows nothing for a runner without the capability", async () => {
    world = await updateWorld();
    world.runner.capable = false;
    await world.start();
    await world.connect();
    await expect(update()).rejects.toEqual(ineligible("unsupported"));
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
    expect(world.runner.frames).toEqual([]);
  });

  it("refuses without a signed artifact for the architecture", async () => {
    await online({ identity: { ...identity, arch: "arm64" } });
    world.artifacts.getUpdate.mockRejectedValueOnce(new Error("missing"));
    await expect(update()).rejects.toEqual(ineligible("no_artifact"));
    expect(world.runner.frames).toEqual([]);
    expect(world.holds.isHeld(RUNNER)).toBe(false);

    world.artifacts.updateEnabled = false;
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
    await expect(update()).rejects.toEqual(ineligible("no_artifact"));
  });

  it("refuses when Dispatch does not know its own revision", async () => {
    await online({ build: { version: target.version, revision: null } });
    await expect(update()).rejects.toEqual(ineligible("no_artifact"));
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
  });

  it.each([
    ["up_to_date", target.version, target.revision],
    ["same_version", target.version, "9".repeat(40)],
    ["runner_newer", "1.10.0", "9".repeat(40)],
    ["unsupported", "1.7", "9".repeat(40)],
  ])("refuses with %s for a runner at %s", async (code, version, revision) => {
    await online({ identity: { ...identity, version, revision } });
    expect(world.coordinator.view(RUNNER)?.available).toBeUndefined();
    await expect(update()).rejects.toEqual(ineligible(code));
    await expect(update("retry")).rejects.toEqual(ineligible(code));
    expect(world.runner.frames).toEqual([]);
  });

  it("orders versions numerically", async () => {
    await online({ identity: { ...identity, version: "1.7.3" } });
    expect(world.coordinator.view(RUNNER)?.available).toBeDefined();
  });

  it("checks again after resolving the artifact", async () => {
    await online();
    const get = world.artifacts.getUpdate.getMockImplementation()!;
    world.artifacts.getUpdate.mockImplementationOnce(async (arch) => {
      await world.disconnect();
      return get(arch);
    });
    await expect(update()).rejects.toEqual(ineligible("offline"));
    expect(world.saved.records).toEqual([]);
  });

  it("refuses while the runner reports another attempt", async () => {
    await online();
    const live = world.service.selfUpdate(RUNNER)!;
    live.advert.pendingAttemptId = "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
    await expect(update()).rejects.toEqual(ineligible("update_in_progress"));
  });

  it("settles recycling before the attempt and does not restart it meanwhile", async () => {
    await online();
    await updated();
    await world.restartController({
      build: { version: "1.7.30", revision: "e".repeat(40) },
    });
    await world.connect();
    await world.until(
      () => world.agents.startRunnerHostRecycling.mock.calls.length
    );
    world.agents.startRunnerHostRecycling.mockClear();
    let settled!: () => void;
    world.agents.settleRunnerHostRecycling.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settled = resolve))
    );
    const request = update();
    await world.until(() => settled);
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    const offers = world.sent("update_offer").length;
    // A reconnect while the pass settles must not start it again.
    await world.connect();
    await world.settle();
    expect(world.agents.startRunnerHostRecycling).not.toHaveBeenCalled();
    expect(world.sent("update_offer")).toHaveLength(offers);
    settled();
    await request;
    // Nor while the runner stages, when nothing is held yet.
    await world.connect();
    await world.settle();
    expect(world.agents.startRunnerHostRecycling).not.toHaveBeenCalled();
  });

  it("resumes recycling when the request ends up ineligible", async () => {
    await online();
    await updated();
    await world.restartController({
      build: { version: "1.7.30", revision: "e".repeat(40) },
    });
    await world.connect();
    await world.settle();
    world.agents.settleRunnerHostRecycling.mockImplementationOnce(async () => {
      world.artifacts.updateEnabled = false;
    });
    world.agents.startRunnerHostRecycling.mockClear();
    await expect(update()).rejects.toEqual(ineligible("no_artifact"));
    expect(world.agents.startRunnerHostRecycling).toHaveBeenCalledOnce();
  });

  it("clears an unreadable fence, then offers", async () => {
    world = await updateWorld();
    world.runner.fenceUnreadable = true;
    await world.start();
    await world.connect();
    expect(world.service.selfUpdate(RUNNER)?.advert.fenceUnreadable).toBe(true);
    await update();
    await world.until(() => world.phase() === "switching");
    expect(world.runner.frames.slice(0, 2).map((f) => f.type)).toEqual([
      "update_cancel",
      "update_offer",
    ]);
  });
});

describe("confirmation evidence", () => {
  it.each([
    ["a socket with no welcome", "socket", INSTANCE],
    ["a welcome with no completed replay", "no-replay", INSTANCE],
    ["no host", "gone", INSTANCE],
    ["another host instance", "ready", "00000000-0000-4000-8000-000000000002"],
  ] as const)("never confirms on %s", async (_case, reply, instance) => {
    await online();
    await switching();
    world.hosts.reply = reply;
    world.hosts.instance = instance;
    await world.swap();
    await world.until(() => world.phase() === "confirming");
    await world.settle(1_200);
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("does not count an attach from an earlier connection", async () => {
    await online();
    await switching();
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
    const session = { sessionId: AGENT, instanceId: INSTANCE };
    const { epoch } = world.service.selfUpdate(RUNNER)!;
    expect(world.agents.isRunnerSessionAttached(RUNNER, session, epoch)).toBe(
      true
    );
    expect(
      world.agents.isRunnerSessionAttached(RUNNER, session, epoch + 1)
    ).toBe(false);
    expect(
      world.agents.isRunnerSessionAttached("rnr_other", session, epoch)
    ).toBe(false);
  });

  it("requires every retained session", async () => {
    await online();
    world.runner.inventory = {
      requiresQuiescence: false,
      live: 2,
      retained: [
        [AGENT, INSTANCE],
        ["agt_other", "00000000-0000-4000-8000-000000000002"],
      ].map(([sessionId, instanceId]) => ({
        sessionId: sessionId!,
        instanceId: instanceId!,
        build: { version: identity.version, revision: identity.revision },
      })),
    };
    await update();
    await world.until(() => world.attempt()?.retained);
    await world.settle(300);
    expect(world.phase()).toBe("settling");
    expect(world.sent("update_activate")).toEqual([]);
  });

  it("only attaches an agent that is placed on that runner", async () => {
    await online();
    await world.agents.attachRunnerSession("rnr_other", AGENT);
    await world.agents.attachRunnerSession(RUNNER, "agt_local");
    expect(world.hosts.attaches).toBe(0);
  });

  it("does not switch before the retained hosts are attached", async () => {
    await online();
    await settling();
    await world.settle(300);
    expect(world.sent("update_activate")).toEqual([]);
    world.advance(UPDATE_TIMING.attachMs);
    await world.until(() => world.result()?.reason === "attach_unavailable");
    expect(world.runner.fence.record).toBeNull();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("waits for a trial report on the current connection", async () => {
    await online();
    await switching();
    await world.until(() =>
      world.runner.statuses.some((status) => status.phase === "activating")
    );
    await world.settle(300);
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("needs a trial report on this connection, however good the attach", async () => {
    await online();
    const attemptId = await confirming();
    await world.disconnect();
    // The next supervisor has not reached the trial yet.
    world.runner.trial = { ...world.runner.trial!, phase: "starting" } as never;
    world.agents.isRunnerSessionAttached = () => true;
    await world.connect();
    await world.settle(300);
    expect(world.sent("update_confirm")).toEqual([]);
    expect(world.attempt()?.id).toBe(attemptId);
  });

  it("ignores a status from a stale connection", async () => {
    await online();
    const { attemptId } = await staging();
    for (const listener of (world.service as any).updateListeners)
      listener({
        runnerId: RUNNER,
        epoch: world.service.connectionEpoch(RUNNER)! - 1,
        status: {
          type: "update_status",
          attemptId,
          phase: "rolled_back",
          installed: identity,
        },
      });
    await world.settle();
    expect(world.phase()).toBe("staging");
  });

  it("ignores another attempt's status", async () => {
    await online();
    await staging();
    world.inject({
      attemptId: "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
      reason: "cancelled",
    });
    await world.settle();
    expect(world.phase()).toBe("staging");
  });

  it.each([
    ["revision", { revision: "9".repeat(40) }],
    ["digest", { sha256: "9".repeat(64) }],
    ["version", { version: "1.7.31" }],
  ])("rolls back a trial with another %s", async (_field, installed) => {
    await online();
    await switching();
    await world.swap(installed);
    await world.until(() => world.result()?.state === "rolled_back");
    expect(world.result()?.reason).toBe("identity_mismatch");
    expect(world.sent("update_confirm")).toEqual([]);
    expect(world.runner.decisions).toEqual(["trial_failed"]);
  });

  it("checks the connection's own identity as well as the status", async () => {
    await online();
    const attemptId = await switching();
    world.inject({
      attemptId,
      phase: "activating",
      reason: "trial",
      installed: {
        version: target.version,
        revision: target.revision,
        sha256: target.sha256,
      },
      retained: [{ sessionId: AGENT, instanceId: INSTANCE }],
    });
    await world.until(() => world.result()?.reason === "identity_mismatch");
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("checks the status as well as the connection's identity", async () => {
    await online();
    const attemptId = await confirming();
    world.inject({
      attemptId,
      phase: "activating",
      reason: "trial",
      installed: {
        version: identity.version,
        revision: identity.revision,
        sha256: identity.sha256,
      },
      retained: [{ sessionId: AGENT, instanceId: INSTANCE }],
    });
    await world.until(() => world.result()?.reason === "identity_mismatch");
  });

  it("rolls back a trial that retains other sessions", async () => {
    await online();
    await switching();
    world.runner.trial!.fence = {
      ...world.runner.trial!.fence,
      retained: [
        {
          sessionId: AGENT,
          instanceId: "00000000-0000-4000-8000-000000000002",
        },
      ],
    };
    await world.swap();
    await world.until(() => world.result()?.reason === "identity_mismatch");
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("does not activate a repeated fence with another retained set", async () => {
    await online();
    const attemptId = await switching();
    const activations = world.sent("update_activate").length;
    world.inject({ attemptId, reason: "fence_ready", retained: [] });
    await world.until(() => world.result()?.reason === "identity_mismatch");
    expect(world.sent("update_activate")).toHaveLength(activations);
  });

  it("does not take an activation it never asked for", async () => {
    await online();
    const { attemptId } = await staging();
    world.inject({ attemptId, phase: "activating", retained: [] });
    await world.until(() => world.result()?.reason === "interrupted");
  });

  it("ignores a confirmation of some other build", async () => {
    await online();
    const attemptId = await switching();
    world.inject({ attemptId, phase: "confirmed" });
    await world.settle();
    expect(world.phase()).toBe("switching");
  });

  it("repeats a confirmation only after a pause", async () => {
    await online();
    await switching();
    const confirm = world.service.confirmUpdate.bind(world.service);
    const sent: number[] = [];
    world.service.confirmUpdate = (...args) => {
      sent.push(world.now());
      return args[3] ? { epoch: args[3] } : confirm(...args);
    };
    await world.swap();
    await world.until(() => sent.length);
    await world.settle(100);
    expect(sent).toHaveLength(1);
    world.advance(UPDATE_TIMING.confirmRetryMs);
    await world.until(() => sent.length === 2);
  });
});

describe("outcomes", () => {
  it.each([
    "boot_failed",
    "confirm_timeout",
    "reattach_failed",
    "trial_interrupted",
    "verify_failed",
  ] as const)("surfaces a rollback for %s", async (reason) => {
    await online();
    await switching();
    await world.swap();
    await world.rollBack(reason);
    await world.until(() => world.result());
    expect(world.coordinator.view(RUNNER)).toEqual({
      available: { version: target.version, action: "retry" },
      result: { state: "rolled_back", version: target.version, reason },
    });
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.agents.startRunnerHostRecycling).not.toHaveBeenCalled();
  });

  it("needs an explicit retry after a rollback, and retries with the flag", async () => {
    await online();
    await rolledBack();
    await expect(update()).rejects.toEqual(ineligible("needs_retry"));
    const rolledBackAttempt = world.attempt()!.id;
    world.runner.trial = null;
    const { attemptId } = await update("retry");
    expect(attemptId).not.toBe(rolledBackAttempt);
    await world.until(() => world.phase() === "switching");
    const offer = world
      .sent("update_offer")
      .find((frame) => frame.attemptId === attemptId);
    expect(offer.retry).toBe(true);
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
    expect(world.saved.records[0]?.failed).toBeUndefined();
  });

  it("remembers suppression through a later deferral", async () => {
    await online();
    await rolledBack();
    world.runner.trial = null;
    world.runner.report = { outcome: "refused", reason: "download_failed" };
    await update("retry");
    await world.until(() => world.result()?.reason === "verify_failed");
    expect(world.coordinator.view(RUNNER)?.available?.action).toBe("retry");
  });

  it("learns suppression from the runner", async () => {
    await online();
    world.runner.suppressed.add(target.sha256);
    await update();
    await world.until(() => world.result());
    expect(world.coordinator.view(RUNNER)).toEqual({
      available: { version: target.version, action: "retry" },
      result: {
        state: "deferred",
        version: target.version,
        reason: "suppressed",
      },
    });
  });

  it("offers a different build without a retry", async () => {
    await online();
    await rolledBack();
    await world.restartController({
      build: { version: "1.7.30", revision: "e".repeat(40) },
    });
    await world.connect();
    expect(world.coordinator.view(RUNNER)).toEqual({
      available: { version: "1.7.30", action: "update" },
    });
  });

  it("names the floor of a refused downgrade", async () => {
    await online();
    world.runner.report = {
      outcome: "refused",
      reason: "downgrade",
      floorVersion: "1.7.31",
    };
    await update();
    await world.until(() => world.result());
    expect(world.result()).toEqual({
      state: "deferred",
      version: target.version,
      reason: "downgrade",
      floorVersion: "1.7.31",
    });
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("surfaces a failed verification", async () => {
    await online();
    world.runner.report = { outcome: "refused", reason: "bad_signature" };
    await update();
    await world.until(() => world.result()?.reason === "verify_failed");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.sent("update_fence")).toEqual([]);
  });

  it("reports an incompatible handoff as needing idle without forcing it", async () => {
    await online();
    world.runner.inventory = {
      retained: [],
      requiresQuiescence: true,
      live: 1,
    };
    await update();
    await world.until(() => world.result());
    expect(world.coordinator.view(RUNNER)).toEqual({
      result: { state: "needs_idle", version: target.version },
    });
    expect(world.sent("update_fence")).toHaveLength(1);
    expect(world.sent("update_fence")[0].retainSessions).toBe(true);
    expect(world.sent("update_activate")).toEqual([]);
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it.each([
    { reason: "incompatible_handoff" },
    { reason: "operations_pending", requiresQuiescence: true },
  ] as const)("reads %o as needing idle", async (status) => {
    await online();
    const { attemptId } = await staging();
    world.inject({ attemptId, ...status });
    await world.until(() => world.result()?.state === "needs_idle");
  });

  it("releases when work did not settle", async () => {
    await online();
    const { attemptId } = await staging();
    world.inject({ attemptId, reason: "operations_pending" });
    await world.until(() => world.result()?.reason === "operations_pending");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("hides a failure once the runner has this build", async () => {
    await online();
    await rolledBack();
    world.runner.identity = { ...world.runner.identity, ...build };
    await world.restartRunner();
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
  });

  it("still reports a rollback between versions of one revision", async () => {
    await online({ identity: { ...identity, revision: target.revision } });
    await rolledBack();
    expect(world.coordinator.view(RUNNER)).toEqual({
      available: { version: target.version, action: "retry" },
      result: {
        state: "rolled_back",
        version: target.version,
        reason: "boot_failed",
      },
    });
  });

  it("hides a success that another version of the same revision replaced", async () => {
    await online();
    await updated();
    world.runner.identity = {
      ...identity,
      version: "1.7.40",
      revision: target.revision,
    };
    await world.restartRunner();
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
  });

  it("hides success and stops recycling after another build is installed", async () => {
    await online();
    await updated();
    world.runner.identity = {
      ...identity,
      version: "1.7.40",
      revision: "8".repeat(40),
    };
    await world.restartRunner();
    expect(world.coordinator.view(RUNNER)).toBeUndefined();
    expect(world.agents.stopRunnerHostRecycling).toHaveBeenCalledWith(RUNNER);
  });

  it("goes back to recycling for the last confirmed build after a failed update", async () => {
    await online();
    await updated();
    const first = world.saved.records[0]!.confirmed;
    await world.restartController({
      build: { version: "1.7.30", revision: "e".repeat(40) },
    });
    await world.connect();
    await world.settle();
    world.agents.startRunnerHostRecycling.mockClear();
    world.runner.trial = null;
    world.runner.report = { outcome: "refused", reason: "failed" };
    await update();
    await world.until(() => world.result()?.reason === "verify_failed");
    expect(world.agents.startRunnerHostRecycling).toHaveBeenLastCalledWith({
      runnerId: RUNNER,
      ...first,
    });
  });
});

describe("deadlines", () => {
  it("cancels staging without ever holding work", async () => {
    await online();
    await staging();
    const begin = vi.spyOn(world.holds, "begin");
    world.advance(UPDATE_TIMING.stagingMs - 1);
    await world.settle();
    expect(world.sent("update_cancel")).toEqual([]);
    world.advance(1);
    await world.until(() => world.result()?.reason === "staging_timeout");
    expect(world.sent("update_cancel")[0].reason).toBe("policy_changed");
    expect(begin).not.toHaveBeenCalled();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("stays held until the cancel is answered or its bound passes", async () => {
    await online();
    await settling();
    world.service.cancelUpdate = () => ({ epoch: 1 });
    world.advance(UPDATE_TIMING.attachMs);
    await world.until(() => world.phase() === "cancelling");
    expect(world.holds.isHeld(RUNNER)).toBe(true);
    expect(world.coordinator.view(RUNNER)?.attempt?.held).toBe(true);
    world.advance(UPDATE_TIMING.cancelMs);
    await world.until(() => world.result()?.reason === "attach_unavailable");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("gives up on work that does not settle", async () => {
    await online();
    const ticket = world.admission.admit(10 * 60_000)!;
    await update();
    await world.until(() => world.sent("update_fence").length);
    await world.until(() => world.phase() === "settling");
    world.advance(UPDATE_TIMING.settlingMs);
    await world.until(() => world.result()?.reason === "settle_timeout");
    expect(world.sent("update_cancel")[0].reason).toBe("quiesce_timeout");
    expect(world.runner.fence.record).toBeNull();
    ticket.release();
  });

  it("asks for a rollback when the switch never reaches a trial", async () => {
    await online();
    await switching();
    world.advance(UPDATE_TIMING.switchingMs);
    await world.until(() => world.result()?.reason === "switch_timeout");
    expect(world.sent("update_cancel")[0].reason).toBe("trial_failed");
  });

  it("rolls back inside the trial when hosts never reattach", async () => {
    await online();
    await confirming();
    world.advance(UPDATE_TIMING.confirmingMs);
    await world.until(() => world.result()?.state === "rolled_back");
    expect(world.result()?.reason).toBe("reattach_failed");
    expect(world.runner.decisions).toEqual(["trial_failed"]);
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("calls an unanswered confirmation a confirm timeout", async () => {
    await online();
    await switching();
    let confirmed = false;
    world.service.confirmUpdate = () => {
      confirmed = true;
      return { epoch: 1 };
    };
    await world.swap();
    await world.until(() => confirmed);
    world.advance(UPDATE_TIMING.confirmingMs);
    await world.until(() => world.result()?.reason === "confirm_timeout");
  });

  it("does not cancel a trial early while the runner is away", async () => {
    await online();
    await confirming();
    await world.disconnect();
    world.advance(UPDATE_TIMING.confirmingMs);
    await world.settle();
    expect(world.phase()).toBe("confirming");
    expect(world.holds.isHeld(RUNNER)).toBe(true);
  });

  it("releases an absent runner at the deadline, then takes its real outcome", async () => {
    await online();
    await confirming();
    await world.disconnect();
    world.advance(UPDATE_TIMING.switchingMs);
    await world.until(() => world.result()?.reason === "no_response");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    await world.endTrial("confirmed");
    await world.restartRunner();
    await world.until(() => world.result()?.state === "updated");
    expect(world.agents.startRunnerHostRecycling).toHaveBeenCalled();
  });

  it("takes a late rollback too", async () => {
    await online();
    await switching();
    await world.disconnect();
    world.advance(UPDATE_TIMING.switchingMs);
    await world.until(() => world.result()?.reason === "no_response");
    world.runner.identity = { ...identity, sha256: target.sha256 };
    await world.rollBack("boot_failed");
    await world.until(() => world.result()?.state === "rolled_back");
    expect(world.result()?.reason).toBe("boot_failed");
  });

  it("does not let a replay rewrite a settled outcome", async () => {
    await online();
    await rolledBack();
    const { id } = world.attempt()!;
    world.inject({ attemptId: id, reason: "cancelled" });
    await world.settle();
    expect(world.result()).toMatchObject({
      state: "rolled_back",
      reason: "boot_failed",
    });
  });

  it("ends when access is revoked", async () => {
    await online();
    await staging();
    world.revoke();
    await world.until(() => world.attempt()?.outcome?.reason === "revoked");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("stops recycling for a revoked runner that disconnects", async () => {
    await online();
    world.revoke();
    await world.disconnect();
    expect(world.agents.stopRunnerHostRecycling).toHaveBeenCalledWith(RUNNER);
  });
});

describe("Dispatch restarts", () => {
  it("resumes while staging, still without a hold", async () => {
    await online();
    const { attemptId, release } = await staging();
    await world.restartController();
    expect(world.phase()).toBe("staging");
    await world.connect();
    await world.settle();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    release();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
    expect(world.attempt()?.id).toBe(attemptId);
  });

  it("resumes while settling, from a fresh fence report", async () => {
    await online();
    const attemptId = await settling();
    await world.restartController();
    expect(world.phase()).toBe("settling");
    world.hosts.reply = "ready";
    await world.connect();
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
    expect(world.attempt()?.id).toBe(attemptId);
    expect(world.sent("update_offer")).toHaveLength(3);
  });

  it("drops a fence report from before a reconnect", async () => {
    await online();
    await settling();
    await world.disconnect();
    // No fence on the runner any more, and the new report is still to come.
    world.runner.fence.record = null;
    world.runner.staging = new Promise(() => {});
    // Good evidence alone must not switch on the old report.
    world.agents.isRunnerSessionAttached = () => true;
    await world.restartRunner();
    await world.settle(300);
    expect(world.sent("update_activate")).toEqual([]);
  });

  it("resumes while switching", async () => {
    await online();
    const attemptId = await switching();
    await world.restartController();
    expect(world.holds.current(RUNNER)?.attemptId).toBe(attemptId);
    expect(world.phase()).toBe("switching");
    await world.connect();
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
  });

  it("resends an activation the runner never received", async () => {
    await online();
    const activate = world.service.activateUpdate.bind(world.service);
    world.service.activateUpdate = () => ({ epoch: 1 });
    await update();
    await world.until(() => world.phase() === "switching");
    world.service.activateUpdate = activate;
    await world.restartController();
    await world.connect();
    await world.swap();
    await world.until(() => world.result()?.state === "updated");
  });

  it("resumes while confirming", async () => {
    await online();
    const attemptId = await confirming();
    await world.restartController();
    expect(world.phase()).toBe("confirming");
    expect(world.holds.current(RUNNER)?.attemptId).toBe(attemptId);
    world.hosts.reply = "ready";
    await world.connect();
    await world.until(() => world.result()?.state === "updated");
  });

  it("reconciles a runner that connected during boot", async () => {
    await online();
    await confirming();
    world.hosts.reply = "ready";
    await world.restartController({ beforeStart: () => world.connect() });
    await world.until(() => world.result()?.state === "updated");
  });

  it("learns a commit that happened while it was down", async () => {
    await online();
    await confirming();
    await world.restartController();
    await world.endTrial("confirmed");
    await world.restartRunner();
    await world.until(() => world.result()?.state === "updated");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it.each(["switching", "confirming"] as const)(
    "never offers again for an unfenced runner while %s",
    async (phase) => {
      await online();
      if (phase === "switching") await switching();
      else await confirming();
      await world.disconnect();
      const offers = world.sent("update_offer").length;
      world.runner.fence.record = null;
      world.runner.trial = null;
      await world.restartRunner();
      await world.until(() => world.attempt()?.outcome);
      expect(world.sent("update_offer")).toHaveLength(offers);
      expect(world.holds.isHeld(RUNNER)).toBe(false);
    }
  );

  it("finishes cancelling, without holding for a cancel of staging", async () => {
    await online();
    await staging();
    world.service.cancelUpdate = () => ({ epoch: 1 });
    world.advance(UPDATE_TIMING.stagingMs);
    await world.until(() => world.phase() === "cancelling");
    await world.restartController();
    const begin = vi.spyOn(world.holds, "begin");
    await world.connect();
    await world.until(() => world.result()?.reason === "staging_timeout");
    expect(begin).not.toHaveBeenCalled();
    expect(world.sent("update_cancel")).toHaveLength(1);
  });

  it("keeps the saved deadline", async () => {
    await online();
    await staging();
    const { deadline } = world.attempt()!;
    world.advance(60_000);
    await world.restartController();
    await world.connect();
    expect(world.attempt()?.deadline).toBe(deadline);
  });

  it("releases the hold of an outcome that was already saved", async () => {
    await online();
    await rolledBack();
    const { id } = world.attempt()!;
    world.saved.holds.holds = [
      {
        runnerId: RUNNER,
        attemptId: id,
        beganAt: new Date(world.now()).toISOString(),
        expiresAt: new Date(world.now() + 60_000).toISOString(),
        launches: [],
      },
    ];
    await world.restartController();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("restarts the recycling pass of a confirmed update", async () => {
    await online();
    await updated();
    const { confirmed } = world.saved.records[0]!;
    await world.restartController();
    await world.connect();
    await world.until(
      () => world.agents.startRunnerHostRecycling.mock.calls.length
    );
    expect(world.agents.startRunnerHostRecycling).toHaveBeenCalledWith({
      runnerId: RUNNER,
      ...confirmed,
    });
  });
});

describe("runner reconnects", () => {
  it("restores an expired hold for its pending attempt", async () => {
    await online();
    const attemptId = await confirming();
    await world.holds.release(RUNNER, attemptId, "expired");
    await world.connect();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("holds again while settling on a runner that lost its fence", async () => {
    await online();
    const attemptId = await settling();
    await world.disconnect();
    await world.holds.release(RUNNER, attemptId, "expired");
    world.runner.fence.record = null;
    world.runner.staging = new Promise(() => {});
    await world.restartRunner();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("holds an attempt saved as staging that the runner is fenced for", async () => {
    await online();
    const attemptId = await settling();
    const { retained: _, ...attempt } = world.saved.records[0]!.attempt;
    world.saved.records[0]!.attempt = { ...attempt, phase: "staging" };
    world.saved.holds = { holds: [], resuming: [] };
    await world.restartController();
    await world.connect();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("holds an activated attempt until its outcome is learned", async () => {
    await online();
    const attemptId = await confirming();
    await world.disconnect();
    await world.holds.release(RUNNER, attemptId, "expired");
    world.runner.fence.record = null;
    world.runner.trial = null;
    world.service.cancelUpdate = () => ({ epoch: 1 });
    await world.restartRunner();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("opens another attempt's hold while its own is staging", async () => {
    await online();
    await staging();
    await world.holds.begin(RUNNER, "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f");
    expect(world.coordinator.view(RUNNER)?.attempt?.held).toBeUndefined();
    await world.connect();
    await world.until(() => !world.holds.isHeld(RUNNER));
    expect(world.phase()).toBe("staging");
  });

  it("cancels what it cannot hold again", async () => {
    await online();
    const attemptId = await settling();
    await world.disconnect();
    await world.holds.release(RUNNER, attemptId, "expired");
    world.holds.begin = async () => {
      throw new Error("hold failed");
    };
    await world.connect();
    await world.until(() => world.result()?.reason === "state_unsaved");
    expect(world.sent("update_offer")).toHaveLength(1);
  });

  it("replaces a hold left by another attempt with its own", async () => {
    await online();
    const attemptId = await confirming();
    const [hold] = world.saved.holds.holds;
    world.saved.holds.holds = [
      { ...hold!, attemptId: "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f" },
    ];
    await world.restartController();
    await world.connect();
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("holds and cancels a pending attempt it has no record of", async () => {
    await online();
    const attemptId = await confirming();
    world.saved.records = [];
    world.saved.holds = { holds: [], resuming: [] };
    await world.restartController();
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    const begun: string[] = [];
    const begin = world.holds.begin.bind(world.holds);
    world.holds.begin = async (...args) => {
      begun.push(args[1]);
      return begin(...args);
    };
    await world.connect();
    await world.until(() => world.result()?.state === "rolled_back");
    // Again on the reconnect that the rollback causes.
    expect(new Set(begun)).toEqual(new Set([attemptId]));
    expect(world.result()?.reason).toBe("interrupted");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.runner.fence.record).toBeNull();
    expect(world.service.selfUpdate(RUNNER)?.advert).not.toHaveProperty(
      "pendingAttemptId"
    );
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("holds a pending attempt until the runner answers the cancel", async () => {
    await online();
    const attemptId = await confirming();
    world.saved.records = [];
    world.saved.holds = { holds: [], resuming: [] };
    await world.restartController();
    world.service.cancelUpdate = () => ({ epoch: 1 });
    await world.connect();
    await world.until(() => world.phase() === "cancelling");
    await world.until(
      () => world.holds.current(RUNNER)?.attemptId === attemptId
    );
  });

  it("adopts a commit of an attempt it has no record of", async () => {
    await online();
    const attemptId = await confirming();
    world.saved.records = [];
    await world.restartController();
    world.service.cancelUpdate = () => ({ epoch: 1 });
    await world.connect();
    await world.until(() => world.phase() === "cancelling");
    world.inject({
      attemptId,
      phase: "confirmed",
      installed: {
        version: target.version,
        revision: target.revision,
        sha256: target.sha256,
      },
    });
    await world.until(() => world.result()?.state === "updated");
    expect(world.saved.records[0]?.confirmed?.revision).toBe(target.revision);
  });

  it("holds and cancels a pending attempt it had given up on", async () => {
    await online();
    await settling();
    await world.disconnect();
    world.advance(UPDATE_TIMING.attachMs);
    await world.until(() => world.result()?.reason === "no_response");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    await world.restartRunner();
    await world.until(
      () =>
        !world.phase() &&
        world.runner.fence.record === null &&
        !world.holds.isHeld(RUNNER)
    );
    expect(world.sent("update_cancel")).toHaveLength(1);
    expect(world.result()?.reason).toBe("no_response");
  });

  it("swaps to another attempt the runner is fenced for", async () => {
    await online();
    await confirming();
    await world.disconnect();
    const other = "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
    world.runner.fence.record = {
      ...world.runner.fence.record!,
      attemptId: other,
    };
    world.runner.trial = null;
    const begun: string[] = [];
    const begin = world.holds.begin.bind(world.holds);
    world.holds.begin = async (...args) => {
      begun.push(args[1]);
      return begin(...args);
    };
    await world.restartRunner();
    await world.until(() => begun.includes(other));
  });

  it("releases a hold nothing is fenced for", async () => {
    await online();
    await world.holds.begin(RUNNER, "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f");
    await world.connect();
    await world.until(() => !world.holds.isHeld(RUNNER));
  });

  it("ends an attempt when the capability is gone", async () => {
    await online();
    await staging();
    world.runner.capable = false;
    await world.connect();
    await world.until(() => world.attempt()?.outcome?.reason === "unsupported");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("clears the cached pending attempt when the runner reports it ended", async () => {
    await online();
    await settling();
    await world.restartRunner();
    const pending = () =>
      world.service.selfUpdate(RUNNER)?.advert.pendingAttemptId;
    const id = world.attempt()!.id;
    await world.until(() => pending() === id);
    world.inject({ attemptId: id, reason: "fence_ready", retained: [] });
    world.inject({
      attemptId: "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
      reason: "cancelled",
    });
    await world.flush();
    expect(pending()).toBe(id);
    world.inject({ attemptId: id, reason: "cancelled" });
    await world.until(() => pending() === undefined);
  });
});

describe("Dispatch rollback", () => {
  const older = { version: "1.7.27", revision: "7".repeat(40) };

  it("cancels rather than confirms a newer target during a trial", async () => {
    await online();
    await confirming();
    world.hosts.reply = "ready";
    await world.restartController({ build: older });
    await world.connect();
    await world.until(() => world.result()?.state === "rolled_back");
    expect(world.result()?.reason).toBe("dispatch_changed");
    expect(world.sent("update_confirm")).toEqual([]);
    expect(world.runner.identity.revision).toBe(identity.revision);
  });

  it("does so for a runner that connected during boot", async () => {
    await online();
    await confirming();
    world.hosts.reply = "ready";
    await world.restartController({
      build: older,
      beforeStart: () => world.connect(),
    });
    await world.until(() => world.result()?.state === "rolled_back");
    expect(world.sent("update_confirm")).toEqual([]);
  });

  it("does not resume a newer offer", async () => {
    await online();
    await staging();
    const offers = world.sent("update_offer").length;
    await world.restartController({ build: older });
    expect(world.attempt()?.reason).toBe("dispatch_changed");
    await world.connect();
    await world.until(() => !world.phase());
    expect(world.sent("update_offer")).toHaveLength(offers);
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("treats another revision of the same version as another build", async () => {
    await online();
    await confirming();
    await world.restartController({
      build: { ...build, revision: "7".repeat(40) },
    });
    expect(world.attempt()?.reason).toBe("dispatch_changed");
  });

  it("never offers an older build to an updated runner", async () => {
    await online();
    await updated();
    await world.restartController({ build: older });
    await world.connect();
    await world.settle();
    const offers = world.sent("update_offer").length;
    expect(world.coordinator.view(RUNNER)?.available).toBeUndefined();
    await expect(update()).rejects.toEqual(ineligible("runner_newer"));
    expect(world.sent("update_offer")).toHaveLength(offers);
  });

  it("does not resume an offer to a runner updated past it meanwhile", async () => {
    await online();
    await staging();
    await world.disconnect();
    const offers = world.sent("update_offer").length;
    world.runner.identity = { ...identity, version: "1.8.0" };
    await world.restartRunner();
    await world.until(() => world.result()?.reason === "runner_newer");
    expect(world.sent("update_offer")).toHaveLength(offers);
  });
});

describe("saving", () => {
  it.each(["settling", "switching"])(
    "does not take the step into %s when it cannot be saved",
    async (phase) => {
      await online();
      world.saved.fail = (records) => records[0]?.attempt.phase === phase;
      await update();
      await world.until(() => world.result()?.reason === "state_unsaved");
      const frame = phase === "settling" ? "update_fence" : "update_activate";
      expect(world.sent(frame)).toEqual([]);
      expect(world.holds.isHeld(RUNNER)).toBe(false);
    }
  );

  it("starts nothing it cannot save", async () => {
    await online();
    world.saved.fail = () => true;
    await expect(update()).rejects.toThrow("disk full");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
    expect(world.runner.frames).toEqual([]);
  });

  it("still releases when an outcome cannot be saved", async () => {
    await online();
    world.saved.fail = (records) => Boolean(records[0]?.attempt.outcome);
    world.runner.report = { outcome: "refused", reason: "failed" };
    await update();
    await world.until(() => world.result()?.reason === "verify_failed");
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("fences nothing it cannot hold", async () => {
    await online();
    world.holds.begin = async () => {
      throw new Error("hold failed");
    };
    await update();
    await world.until(() => world.result()?.reason === "state_unsaved");
    expect(world.sent("update_fence")).toEqual([]);
    expect(world.admission.closed).toBe(false);
  });

  it("keeps a private file and sets a damaged one aside", async () => {
    await online();
    await updated();
    const directory = await mkdtemp(path.join(os.tmpdir(), "dr-attempts-"));
    try {
      const file = path.join(directory, "runner-update", "attempts.json");
      const store = fileRunnerUpdateStore(file, logger);
      expect(await store.read()).toEqual([]);
      await store.write(world.saved.records);
      expect(await store.read()).toEqual(world.saved.records);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await writeFile(file, "{", { mode: 0o600 });
      expect(await store.read()).toEqual([]);
      expect(await readdir(path.dirname(file))).toEqual([
        expect.stringMatching(/^attempts\.json\.rejected-/),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
