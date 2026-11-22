/**
 * A forced runner update end to end on Dispatch's side: receipt before any
 * interrupt, exact turns cut, every session resumed once, and one
 * continuation to each agent whose turn was cut, ahead of held work.
 */
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RECONNECT_WARNING } from "../../src/agents/reconciler.js";
import { UPDATE_TIMING } from "../../src/agents/remote/update-coordinator.js";
import {
  continuationId,
  UPDATE_CONTINUATION_MESSAGE,
} from "../../src/agents/remote/force-sessions.js";
import {
  forceWorld,
  RUNNER,
  type Host,
} from "../helpers/runner-force-fixture.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

let pool: Pool;
let world: Awaited<ReturnType<typeof forceWorld>>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM files");
  await pool.query("DELETE FROM agents");
  world = await forceWorld(pool);
});
afterEach(async () => {
  await world.close();
});

const force = () => world.coordinator.forceUpdate(RUNNER);
const continuations = (host: Host) =>
  host.prompts.filter(({ text }) => text === UPDATE_CONTINUATION_MESSAGE);
const statusOf = async (id: string) =>
  (await pool.query("SELECT status FROM agents WHERE id = $1", [id])).rows[0]
    ?.status;
const finished = (state = "updated") =>
  world.until(() => world.view()?.result?.state === state);
async function updated() {
  await world.activated();
  world.swap();
  await finished();
}
/** Resumed into its own session, by this attempt, and only once. */
function resumedOnce(host: Host) {
  expect(host.launches.slice(1)).toEqual([
    { launchId: world.attempt()!.id, resume: host.sessionId },
  ]);
  expect(host.alive).toBe(true);
}

describe("a forced update", () => {
  it("resumes a long turn, a waiting parent and idle agents once, and tells only the cut ones to continue, before held work", async () => {
    const long = await world.agent();
    const parent = await world.agent();
    const idle = await world.agent();
    const legacy = await world.agent({ legacy: true });
    const conversation = { streamId: long.id, threadId: "thread" };
    const longSeq = await world.working(long, {
      source: "system",
      text: "long",
      conversation,
    });
    const parentSeq = await world.working(parent);

    let receiptAtInterrupt: string[] | undefined;
    let heldAtInterrupt: boolean | undefined;
    const append = long.append;
    long.append = (event) => {
      receiptAtInterrupt ??= world
        .attempt()
        ?.drain?.agents.map(({ id }) => id)
        .sort();
      heldAtInterrupt ??= world.holds.isHeld(RUNNER);
      append(event);
    };
    const { attemptId } = await force();
    await world.until(() => world.view()?.attempt?.phase === "interrupting");
    const ordinary = world.prompt(long, "ordinary");
    await world.activated();

    expect(long.interrupts).toEqual([longSeq]);
    expect(parent.interrupts).toEqual([parentSeq]);
    expect(idle.interrupts).toEqual([]);
    expect(legacy.interrupts).toEqual([]);
    expect(heldAtInterrupt).toBe(true);
    expect(receiptAtInterrupt).toEqual(
      [long.id, parent.id, idle.id, legacy.id].sort()
    );
    for (const host of [long, parent, idle, legacy]) {
      expect(host.alive).toBe(false);
      expect(host.launches).toHaveLength(1);
      expect(await statusOf(host.id)).toBe("running");
    }
    // The fence saw an empty runner.
    expect(world.runner.frames.filter((f) => f.type === "fence")).toEqual([
      { type: "fence", attemptId, retainSessions: false },
    ]);

    world.swap();
    await finished();
    await ordinary.accepted;
    for (const host of [long, parent, idle, legacy]) resumedOnce(host);
    expect(long.prompts.map(({ text }) => text)).toEqual([
      UPDATE_CONTINUATION_MESSAGE,
      "ordinary",
    ]);
    expect(long.prompts[0]).toMatchObject({
      id: continuationId(attemptId, long.id),
      source: { source: "system", conversation },
    });
    expect(parent.prompts.map(({ text }) => text)).toEqual([
      UPDATE_CONTINUATION_MESSAGE,
    ]);
    expect(idle.prompts).toEqual([]);
    expect(legacy.prompts).toEqual([]);
    expect(world.holds.isHeld(RUNNER)).toBe(false);
  });

  it("leaves a plain update waiting, and escalates it only when asked", async () => {
    world.runner.incompatible = true;
    const drained = await world.agent();
    const busy = await world.agent({ legacy: true });
    const seq = await world.working(busy);
    const { attemptId } = await world.coordinator.request(RUNNER, "update");
    await world.until(
      () => !drained.alive && world.view()?.attempt?.agents === 1
    );
    expect(world.view()?.attempt?.phase).toBe("draining");
    expect(busy.interrupts).toEqual([]);
    expect(busy.stops).toBe(0);
    expect(world.attempt()?.force).toBeUndefined();

    await expect(
      world.coordinator.forceUpdate(RUNNER, crypto.randomUUID())
    ).rejects.toMatchObject({ code: "stale_drain" });
    expect(await world.coordinator.forceUpdate(RUNNER, attemptId)).toEqual({
      attemptId,
    });
    expect(world.view()?.attempt).toMatchObject({
      phase: "interrupting",
      agents: 1,
    });
    // A second click is the same force, and nothing is left to cancel.
    expect(await world.coordinator.forceUpdate(RUNNER, attemptId)).toEqual({
      attemptId,
    });
    await expect(
      world.coordinator.cancelDrain(RUNNER, attemptId)
    ).rejects.toMatchObject({ code: "stale_drain" });

    await updated();
    expect(busy.interrupts).toEqual([seq]);
    resumedOnce(drained);
    resumedOnce(busy);
    expect(drained.prompts).toEqual([]);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("does not share an attempt with a plain update", async () => {
    const plain = world.coordinator.request(RUNNER, "update");
    const forced = world.coordinator.forceUpdate(RUNNER);
    const results = await Promise.allSettled([plain, forced]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(world.attempt()?.force).toBeUndefined();
  });

  it("sends nothing for a turn that finished just as it was interrupted", async () => {
    const racing = await world.agent();
    racing.onInterrupt = "completes";
    const seq = await world.working(racing);
    await force();
    await updated();
    expect(racing.interrupts).toEqual([seq]);
    resumedOnce(racing);
    expect(racing.prompts).toEqual([]);
  });

  it("stops a host whose turn will not settle, after a bounded wait", async () => {
    const stuck = await world.agent();
    stuck.onInterrupt = "ignores";
    await world.working(stuck);
    await force();
    await world.until(() => stuck.interrupts.length === 1);
    expect(stuck.stops).toBe(0);
    world.advance(UPDATE_TIMING.interruptMs);
    await updated();
    expect(stuck.interrupts).toHaveLength(1);
    expect(stuck.stops).toBe(1);
    resumedOnce(stuck);
    expect(continuations(stuck)).toHaveLength(1);
  });

  it("interrupts only the snapshotted turn, and tells an agent once when a later turn is cut by the stop", async () => {
    const busy = await world.agent();
    const other = await world.agent();
    other.onInterrupt = "ignores";
    const seq = await world.working(busy);
    await world.working(other);
    await force();
    await world.until(() => !busy.turn && other.interrupts.length);
    // The engine goes on by itself while the other host is still settling.
    await world.working(busy, { source: "engine", text: "goal" });
    world.advance(UPDATE_TIMING.interruptMs);
    await updated();
    expect(busy.interrupts).toEqual([seq]);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("interrupts the same turn again from the welcome after a reconnect, and no other", async () => {
    const busy = await world.agent();
    busy.onInterrupt = "silent";
    const seq = await world.working(busy);
    await force();
    await world.until(() => busy.interrupts.length === 1);
    world.disconnect();
    busy.onInterrupt = "cancel";
    world.reconnect();
    await updated();
    expect(busy.interrupts).toEqual([seq, seq]);
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("waits for a turn that settled while the runner was away without interrupting its successor", async () => {
    const busy = await world.agent();
    busy.onInterrupt = "silent";
    const seq = await world.working(busy);
    await force();
    await world.until(() => busy.interrupts.length === 1);
    world.disconnect();
    busy.settle("end_turn");
    world.reconnect();
    await updated();
    expect(busy.interrupts).toEqual([seq]);
    expect(busy.prompts).toEqual([]);
  });

  it("repeats nothing on a duplicate terminal status", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.swap();
    await world.until(() => world.view()?.attempt?.phase === "resuming");
    world.report("confirmed");
    world.report("rolled_back", "boot_failed");
    await finished();
    world.report("confirmed");
    await world.coordinator.tick();
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
    expect(world.view()?.result?.state).toBe("updated");
  });
});

describe("failure after interruption", () => {
  it("resumes on the previous build after a rollback and still continues once", async () => {
    const busy = await world.agent();
    const idle = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.rollBack();
    await finished("rolled_back");
    resumedOnce(busy);
    resumedOnce(idle);
    expect(continuations(busy)).toHaveLength(1);
    expect(idle.prompts).toEqual([]);
  });

  it("recovers a partial stop: the live host reattaches, the stopped one resumes", async () => {
    const stays = await world.agent();
    const stops = await world.agent();
    stays.stopFails = true;
    await world.working(stays);
    await world.working(stops);
    await force();
    await world.until(() => !stops.alive && stays.stops > 0);
    expect(world.effects).not.toContain("activate");
    world.advance(UPDATE_TIMING.interruptingMs);
    await finished("deferred");
    expect(world.view()?.result?.reason).toBe("force_timeout");
    expect(stays.launches).toHaveLength(1);
    resumedOnce(stops);
    expect(continuations(stays)).toHaveLength(1);
    expect(continuations(stops)).toHaveLength(1);
  });

  it("gives up on a session that won't resume without holding up the others", async () => {
    const broken = await world.agent();
    const fine = await world.agent();
    await world.working(fine);
    await force();
    await world.activated();
    broken.resumeFails = true;
    world.swap();
    await world.until(
      () => continuations(fine).length && world.entry(broken.id)?.failedAt
    );
    expect(world.holds.isHeld(RUNNER)).toBe(true);
    world.advance(UPDATE_TIMING.resumeRetryMs);
    await finished();
    expect(await statusOf(broken.id)).toBe("error");
    expect(continuations(fine)).toHaveLength(1);
    expect(broken.prompts).toEqual([]);
  });
});

describe("hosts that go down untidily", () => {
  it("resumes and continues an agent whose engine died of the interrupt", async () => {
    const busy = await world.agent();
    busy.onInterrupt = "crashes";
    await world.working(busy);
    await force();
    await updated();
    expect(await statusOf(busy.id)).toBe("running");
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("keeps held work when the replacement replays the old host's exit", async () => {
    const busy = await world.agent();
    busy.stopLosesExit = true;
    await world.working(busy);
    await force();
    await world.until(() => world.view()?.attempt?.phase === "interrupting");
    const ordinary = world.prompt(busy, "ordinary");
    await updated();
    await ordinary.accepted;
    expect(busy.prompts.map(({ text }) => text)).toEqual([
      UPDATE_CONTINUATION_MESSAGE,
      "ordinary",
    ]);
  });

  it("keeps the receipt when the runner returns fenced for another attempt", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.disconnect();
    world.reconnect(crypto.randomUUID());
    await finished("deferred");
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });
});

describe("agents the user changed during the update", () => {
  it("never resumes or messages a stopped, archived, deleted or changed agent", async () => {
    const stopped = await world.agent();
    const archived = await world.agent();
    const deleted = await world.agent();
    const changed = await world.agent();
    const all = [stopped, archived, deleted, changed];
    for (const host of all) await world.working(host);
    await force();
    await world.activated();
    await world.manager.stopAgent(stopped.id);
    await world.manager.beginArchive(archived.id);
    await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
      deleted.id,
    ]);
    await world.manager.renameAgent(changed.id, "changed");
    world.swap();
    await finished();
    for (const host of all) {
      expect(host.launches).toHaveLength(1);
      expect(host.prompts).toEqual([]);
    }
    expect(await statusOf(stopped.id)).toBe("stopped");
    expect(await statusOf(archived.id)).toBe("archiving");
  });

  it("lets a stop asked for while interrupting win", async () => {
    const busy = await world.agent();
    busy.onInterrupt = "ignores";
    await world.working(busy);
    await force();
    await world.until(() => busy.interrupts.length === 1);
    const stop = world.manager.stopAgent(busy.id);
    await world.until(() => (world.manager as any).stoppingOrArchiving.size);
    world.advance(UPDATE_TIMING.interruptMs);
    await updated();
    await stop;
    expect(busy.launches).toHaveLength(1);
    expect(busy.prompts).toEqual([]);
    expect(await statusOf(busy.id)).toBe("stopped");
  });

  it("sends no continuation to an agent stopped after it resumed", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    let stop: Promise<unknown> | undefined;
    world.saved.afterWrite = () => {
      if (!stop && world.entry(busy.id)?.resumed)
        stop = world.manager.stopAgent(busy.id);
    };
    world.swap();
    await finished();
    await stop;
    expect(busy.prompts).toEqual([]);
    expect(await statusOf(busy.id)).toBe("stopped");
  });
});

describe("stop and archive while a drain waits", () => {
  it("go through without the hold opening, and neither agent is resumed", async () => {
    world.runner.incompatible = true;
    const drained = await world.agent();
    const keeps = await world.agent();
    const stopping = await world.agent();
    const archiving = await world.agent();
    const blocker = await world.agent();
    for (const host of [stopping, archiving, blocker])
      await world.working(host);
    const { attemptId } = await world.coordinator.request(RUNNER, "update");
    await world.until(
      () =>
        !drained.alive && !keeps.alive && world.view()?.attempt?.agents === 3
    );
    expect(world.entry(drained.id)).toBeDefined();

    await world.manager.stopAgent(drained.id);
    await world.manager.stopAgent(stopping.id);
    expect(await statusOf(stopping.id)).toBe("stopped");
    await world.manager.beginArchive(archiving.id);
    await world.manager.executeArchive(archiving.id, {
      onPhaseChange() {},
      onComplete() {},
      onError(error) {
        throw error;
      },
    });
    await world.until(
      () => !world.entry(drained.id) && world.view()?.attempt?.agents === 1
    );
    expect(world.view()?.attempt?.phase).toBe("draining");
    expect(world.holds.isHeld(RUNNER)).toBe(true);
    expect(stopping.alive || archiving.alive).toBe(false);
    expect(await world.manager.getAgent(archiving.id)).toBeNull();

    await world.coordinator.cancelDrain(RUNNER, attemptId);
    await finished("deferred");
    resumedOnce(keeps);
    for (const host of [drained, stopping, archiving, blocker])
      expect(host.launches).toHaveLength(1);
    expect(await statusOf(drained.id)).toBe("stopped");
  });

  it("keeps a host restart waiting without holding up a stop", async () => {
    world.runner.incompatible = true;
    const busy = await world.agent();
    await world.working(busy);
    const { attemptId } = await world.coordinator.request(RUNNER, "update");
    await world.until(() => world.view()?.attempt?.phase === "draining");
    const restart = world.manager.restartHost(busy.id);
    await world.until(() => (world.holds as any).waiters.get(RUNNER)?.length);
    expect(busy.alive).toBe(true);
    await world.manager.stopAgent(busy.id);
    await world.coordinator.cancelDrain(RUNNER, attemptId);
    await finished("deferred");
    await restart;
    expect(busy.launches).toHaveLength(1);
    expect(await statusOf(busy.id)).toBe("stopped");
  });

  it("lets a stop through that began waiting before the drain did", async () => {
    world.runner.incompatible = true;
    const busy = await world.agent();
    const later = await world.agent();
    await world.working(busy);
    await world.holds.begin(RUNNER, crypto.randomUUID());
    const waiting = world.holds.current(RUNNER)!.attemptId;
    const stop = world.manager.stopAgent(busy.id);
    await world.until(() => world.holds.counts(RUNNER).stops === 1);
    world.holds.setDrainWaiting(RUNNER, waiting, true);
    await stop;
    expect(await statusOf(busy.id)).toBe("stopped");
    expect(world.holds.isHeld(RUNNER)).toBe(true);

    // Fenced again: the next one waits.
    world.holds.setDrainWaiting(RUNNER, waiting, false);
    const next = world.manager.stopAgent(later.id);
    await world.until(() => world.holds.counts(RUNNER).stops === 1);
    expect(later.alive).toBe(true);
    await world.holds.release(RUNNER, waiting, "cancelled");
    await next;
  });
});

describe("liveness while a drain waits", () => {
  it("asks only about hosts it isn't attached to, and only every ten seconds", async () => {
    world.runner.incompatible = true;
    const busy = await world.agent();
    const idle = await world.agent();
    const detached = await world.agent();
    await world.working(busy);
    detached.attachFails = true;
    detached.socket!.destroy();
    await vi.waitFor(() =>
      expect(
        (world.manager as any).runtime
          .runnerHosts(RUNNER)
          .find((h: { agentId: string }) => h.agentId === detached.id)
          ?.attachedEpoch
      ).toBeUndefined()
    );
    await world.coordinator.request(RUNNER, "update");
    await world.until(() => !idle.alive && world.view()?.attempt?.agents === 2);
    await world.coordinator.tick();
    // Attaches run beside the pass that started them.
    await vi.waitFor(() =>
      expect((world.coordinator as any).attaching.size).toBe(0)
    );
    const hosts = [busy, idle, detached];
    for (const host of hosts) host.asked = 0;
    for (let i = 0; i < 5; i++) await world.coordinator.tick();
    expect(hosts.map(({ asked }) => asked)).toEqual([0, 0, 0]);

    world.advance(UPDATE_TIMING.drainProbeMs);
    await world.coordinator.tick();
    expect(busy.asked).toBe(0);
    expect(idle.asked).toBe(1);
    expect(detached.asked).toBeGreaterThan(0);
  });

  it("ends the wait only on fresh answers", async () => {
    world.runner.incompatible = true;
    const busy = await world.agent();
    const gone = await world.agent();
    await world.working(busy);
    await world.coordinator.request(RUNNER, "update");
    await world.until(() => !gone.alive && world.view()?.attempt?.agents === 1);
    await world.coordinator.tick();
    // Back, as a launch admitted before the hold would be.
    gone.alive = gone.attachFails = true;
    gone.asked = 0;
    busy.settle();
    await world.until(() => !busy.alive && gone.asked > 0);
    expect(world.view()?.attempt).toMatchObject({
      phase: "draining",
      agents: 1,
    });
  });
});

describe("a runner that stays offline while resuming", () => {
  /** Both hosts are down and owed a resume when the runner drops. */
  async function offlineResuming() {
    const busy = await world.agent();
    const idle = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.saved.afterWrite = () => {
      if (world.attempt()?.phase !== "resuming") return;
      world.saved.afterWrite = undefined;
      world.disconnect();
    };
    world.swap();
    await world.until(() => !world.saved.afterWrite);
    await world.until(
      () =>
        Date.parse(world.saved.holds.holds[0]!.expiresAt) <=
        world.attempt()!.deadline
    );
    expect(world.view()?.attempt).toMatchObject({
      phase: "resuming",
      agents: 2,
    });
    return { busy, idle };
  }

  it.each([false, true])(
    "ends at the deadline and leaves its agents to the reconciler (controller restarted: %s)",
    async (restarted) => {
      const { busy, idle } = await offlineResuming();
      const deadline = world.attempt()!.deadline;
      if (restarted) world.crash();
      world.advance(UPDATE_TIMING.resumingMs);
      if (restarted) await world.restart();
      await world.until(
        () => !world.holds.isHeld(RUNNER) && !world.view()?.attempt
      );

      expect(world.attempt()).toMatchObject({
        deadline,
        outcome: { state: "updated" },
      });
      expect(world.attempt()?.drain).toBeUndefined();
      for (const host of [busy, idle]) {
        expect((world.manager as any).hasRunnerDrainReceipt(host.id)).toBe(
          false
        );
      }
      // Unreachable is not gone.
      await world.manager.reconcileAgentStatuses();
      for (const host of [busy, idle])
        expect(await world.manager.getAgent(host.id)).toMatchObject({
          status: "running",
          lastError: RECONNECT_WARNING,
        });
      world.reconnect();
      await world.manager.reconcileAgentStatuses();
      for (const host of [busy, idle]) {
        expect(await statusOf(host.id)).toBe("stopped");
        expect(host.launches).toHaveLength(1);
        expect(host.prompts).toEqual([]);
      }
    }
  );

  it.each([false, true])(
    "resumes normally when the runner is back before it (controller restarted: %s)",
    async (restarted) => {
      const { busy, idle } = await offlineResuming();
      if (restarted) world.crash();
      world.advance(UPDATE_TIMING.resumingMs - 60_000);
      if (restarted) await world.restart();
      await world.coordinator.tick();
      expect(world.view()?.attempt?.phase).toBe("resuming");
      world.reconnect();
      await finished();
      resumedOnce(busy);
      resumedOnce(idle);
      expect(continuations(busy)).toHaveLength(1);
    }
  );

  it("brings a cancelled drain's two-hour hold in to the deadline", async () => {
    world.runner.incompatible = true;
    const drained = await world.agent();
    const busy = await world.agent();
    await world.working(busy);
    const { attemptId } = await world.coordinator.request(RUNNER, "update");
    await world.until(
      () => !drained.alive && world.view()?.attempt?.agents === 1
    );
    world.disconnect();
    await world.coordinator.cancelDrain(RUNNER, attemptId);
    const { deadline } = world.attempt()!;
    await world.until(
      () => Date.parse(world.saved.holds.holds[0]!.expiresAt) === deadline
    );
    world.reconnect();
    await finished("deferred");
    resumedOnce(drained);
  });

  it("fails what it can tell is gone", async () => {
    const { busy, idle } = await offlineResuming();
    busy.resumeFails = idle.resumeFails = true;
    world.advance(UPDATE_TIMING.resumingMs - 60_000);
    world.reconnect();
    await world.until(() => world.entry(busy.id)?.failedAt);
    world.advance(60_000);
    await finished();
    for (const host of [busy, idle])
      expect(await statusOf(host.id)).toBe("error");
  });
});

describe("a controller crash", () => {
  it("after the receipt, before any interrupt", async () => {
    const busy = await world.agent();
    const idle = await world.agent();
    const seq = await world.working(busy);
    world.saved.afterWrite = () => {
      if (!world.entry(busy.id)) return;
      world.saved.afterWrite = undefined;
      world.crash();
    };
    await force();
    await world.until(() => !world.saved.afterWrite);
    expect(busy.interrupts).toEqual([]);
    expect(idle.stops).toBe(0);
    await world.restart();
    await updated();
    expect(busy.interrupts).toEqual([seq]);
    resumedOnce(busy);
    resumedOnce(idle);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("after the stop, before its claim was refreshed", async () => {
    const busy = await world.agent();
    await world.working(busy);
    world.saved.beforeWrite = () => {
      if (busy.stops === 0) return;
      world.saved.beforeWrite = undefined;
      world.crash();
      throw new Error("controller stopped");
    };
    await force();
    await world.until(() => !world.saved.beforeWrite);
    await world.restart();
    await updated();
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("with the hosts stopped, before the switch", async () => {
    const busy = await world.agent();
    await world.working(busy);
    world.saved.afterWrite = () => {
      if (world.attempt()?.phase !== "settling") return;
      world.saved.afterWrite = undefined;
      world.crash();
    };
    await force();
    await world.until(() => !world.saved.afterWrite);
    expect(busy.alive).toBe(false);
    await world.restart();
    expect(await statusOf(busy.id)).toBe("running");
    await updated();
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  type Records = Parameters<NonNullable<typeof world.saved.beforeWrite>>[0];
  const agentsIn = (records: Records) => records[0]?.attempt.drain?.agents;

  it.each([
    [
      "after the launch, before its progress was saved",
      (next: Records) => agentsIn(next)?.some((entry) => entry.resumed),
    ],
    [
      "after the continuation was accepted, before that was saved",
      (next: Records) =>
        next[0]?.attempt.phase === "resuming" && agentsIn(next)?.length === 0,
    ],
    [
      "before the continuation was marked sent",
      (next: Records) =>
        agentsIn(next)?.some((entry) => entry.continuationSent),
    ],
  ])("during resume, %s", async (_case, at) => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.saved.beforeWrite = (next) => {
      if (!at(next)) return;
      world.saved.beforeWrite = undefined;
      world.crash();
      throw new Error("controller stopped");
    };
    world.swap();
    await world.until(() => !world.saved.beforeWrite);
    await world.restart();
    await finished();
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("after the continuation was marked sent, before it left", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.saved.afterWrite = () => {
      if (!world.entry(busy.id)?.continuationSent) return;
      world.saved.afterWrite = undefined;
      world.crash();
    };
    world.swap();
    await world.until(() => !world.saved.afterWrite);
    expect(busy.prompts).toEqual([]);
    await world.restart();
    await finished();
    resumedOnce(busy);
    expect(continuations(busy)).toHaveLength(1);
  });

  it("does not launch again when the host it launched died while Dispatch was down", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    world.saved.beforeWrite = (next) => {
      if (!agentsIn(next)?.some((entry) => entry.resumed)) return;
      world.saved.beforeWrite = undefined;
      world.crash();
      busy.alive = false;
      throw new Error("controller stopped");
    };
    world.swap();
    await world.until(() => !world.saved.beforeWrite);
    await world.restart();
    await finished();
    expect(busy.launches).toHaveLength(2);
    expect(busy.prompts).toEqual([]);
  });

  it("leaves a continuation the host only claimed", async () => {
    const busy = await world.agent();
    await world.working(busy);
    const { attemptId } = await force();
    await world.activated();
    world.saved.beforeWrite = (next) => {
      if (next[0]?.attempt.phase !== "resuming" || agentsIn(next)?.length)
        return;
      world.saved.beforeWrite = undefined;
      world.crash();
      busy.receipts.set(continuationId(attemptId, busy.id), "claimed");
      throw new Error("controller stopped");
    };
    world.swap();
    await world.until(() => !world.saved.beforeWrite);
    await world.restart();
    await finished();
    expect(continuations(busy)).toHaveLength(1);
  });

  it("never resends to a host without receipts", async () => {
    const busy = await world.agent({ legacy: true });
    await world.working(busy);
    await force();
    await world.activated();
    world.saved.beforeWrite = (next) => {
      if (next[0]?.attempt.phase !== "resuming" || agentsIn(next)?.length)
        return;
      world.saved.beforeWrite = undefined;
      world.crash();
      throw new Error("controller stopped");
    };
    world.swap();
    await world.until(() => !world.saved.beforeWrite);
    await world.restart();
    await finished();
    expect(continuations(busy)).toHaveLength(1);
  });
});
