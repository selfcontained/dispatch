/**
 * A forced runner update end to end on Dispatch's side: receipt before any
 * interrupt, exact turns cut, every session resumed once, and one
 * continuation to each agent whose turn was cut, ahead of held work.
 */
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import {
  fileRunnerUpdateStore,
  UPDATE_TIMING,
} from "../../src/agents/remote/update-coordinator.js";
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
import { stopLocalRunners } from "../helpers/local-runner-child.js";

vi.mock(
  "../../../../packages/runner/src/workload/shared/lib/run-command.js",
  () => import("../../src/shared/lib/run-command.js")
);
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
  await stopLocalRunners();
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

describe("runner receipt recovery after rolling back Dispatch", () => {
  it.each([true, false])(
    "reconciles after boot when the set-aside receipt is readable=%s",
    async (readable) => {
      const busy = await world.agent();
      await world.working(busy);
      await force();
      await world.activated();
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "runner-receipt-")
      );
      const file = path.join(directory, "attempts.json");
      const rejected = `${file}.rejected-${Date.now()}`;
      const store = fileRunnerUpdateStore(file);
      try {
        if (readable) {
          await store.write(world.saved.records);
          await rename(file, rejected);
        } else {
          await writeFile(rejected, "{unreadable", { mode: 0o600 });
        }
        world.swap();
        await world.restart({
          readAttempts: store.read,
          olderBuild: !readable,
        });
        if (!readable) {
          expect(await statusOf(busy.id)).toBe("stopped");
          expect(busy.launches).toHaveLength(1);
          expect(continuations(busy)).toHaveLength(0);
          return;
        }
        await world.until(() => Boolean(world.attempt()?.outcome));
        resumedOnce(busy);
        expect(continuations(busy)).toHaveLength(1);
        // Simulate subsequent normal saves and prove the backup was moved.
        await store.write(world.saved.records);
        await rm(file);
        expect(await store.read()).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});

describe("automatic runner updates", () => {
  const enable = async () => {
    await world.coordinator.setAutomatic(RUNNER, true);
    world.advance(UPDATE_TIMING.automaticSettleMs + 1);
    await world.coordinator.tick();
  };
  const offers = () =>
    world.runner.frames.filter(({ type }) => type === "offer");

  it("does not offer until it has a trusted build", async () => {
    world.runner.trust = false;
    await enable();
    expect(offers()).toEqual([]);
    world.runner.trust = true;
    world.advance(UPDATE_TIMING.automaticSpacingMs);
    await world.until(() => offers().length === 1);
  });

  it("honors opt-out during staging", async () => {
    world.runner.holdStaging = true;
    await enable();
    await world.until(() => offers().length === 1);
    await world.coordinator.setAutomatic(RUNNER, false);
    await finished("deferred");
    // Ready frames from the old offer can arrive after cancel.
    world.report("deferred", "ready");
    world.report("deferred", "ready");
    world.advance(UPDATE_TIMING.automaticSpacingMs);
    await world.coordinator.tick();
    expect(world.runner.frames.map(({ type }) => type)).toEqual([
      "offer",
      "cancel",
    ]);
    expect(world.view()?.available?.action).toBe("update");
  });

  it.each(["cancel", "opt-out"] as const)(
    "releases an automatic drain after %s without interrupting the busy agent",
    async (action) => {
      const idle = await world.agent();
      const busy = await world.agent();
      await world.working(busy);
      world.runner.incompatible = true;
      await enable();
      await world.until(
        () => !idle.alive && world.view()?.attempt?.agents === 1
      );
      const { id, automatic } = world.attempt()!;
      expect(automatic).toBe(true);
      expect(busy.alive).toBe(true);
      expect(world.attempt()?.force).toBeUndefined();
      if (action === "cancel") await world.coordinator.cancelDrain(RUNNER, id);
      else await world.coordinator.setAutomatic(RUNNER, false);
      await finished("deferred");
      resumedOnce(idle);
      expect(continuations(busy)).toHaveLength(0);
      world.advance(UPDATE_TIMING.automaticSpacingMs);
      await world.coordinator.tick();
      expect(offers()).toHaveLength(1);
      expect(world.view()?.result?.reason).toBe(
        action === "cancel" ? "automatic_drain_cancelled" : "automatic_disabled"
      );
      await world.coordinator.request(RUNNER, "update");
      expect(offers()).toHaveLength(2);
    }
  );

  it("ignores an interruption marker on an automatic offer", async () => {
    const busy = await world.agent();
    await world.working(busy);
    world.runner.incompatible = true;
    world.saved.beforeWrite = (records) => {
      const attempt = records[0]?.attempt;
      if (attempt?.automatic && attempt.phase === "staging")
        attempt.force = true;
    };
    await enable();
    await world.until(() => world.view()?.attempt?.phase !== "staging");
    expect(world.view()?.attempt?.phase).toBe("draining");
    expect(busy.alive).toBe(true);
    expect(continuations(busy)).toHaveLength(0);
  });

  it("leaves an activated attempt alone on opt-out", async () => {
    await enable();
    await world.activated();
    await world.coordinator.setAutomatic(RUNNER, false);
    world.swap();
    await finished();
    expect(world.runner.frames.some(({ type }) => type === "cancel")).toBe(
      false
    );
  });

  it("suppresses a failed target until an explicit retry", async () => {
    await enable();
    await world.activated();
    world.rollBack();
    await finished("rolled_back");
    world.advance(UPDATE_TIMING.automaticSpacingMs);
    await world.coordinator.tick();
    expect(offers()).toHaveLength(1);
    expect(world.view()?.available?.action).toBe("retry");
    await world.coordinator.request(RUNNER, "retry");
    expect(offers()).toHaveLength(2);
  });
});

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
    // The one deliberate literal pin of the continuation wording; the matrix
    // tests use UPDATE_CONTINUATION_MESSAGE.
    expect(long.prompts.map(({ text }) => text)).toEqual([
      "Dispatch interrupted this turn to update the runner; the user did not interrupt it. Continue from where you left off.",
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

  it.each([
    "staging",
    "settling",
    "cancelling",
    "resuming",
    "switching",
    "confirming",
  ] as const)("is not asked for again while %s", async (phase) => {
    const { attemptId } = await force();
    await world.activated();
    const records = (world.coordinator as any).records;
    const record = records.get(RUNNER);
    records.set(RUNNER, {
      ...record,
      attempt: { ...record.attempt, phase },
    });
    await expect(
      world.coordinator.forceUpdate(RUNNER, attemptId)
    ).rejects.toMatchObject({ code: "stale_drain" });
    await expect(force()).rejects.toMatchObject({
      code: "update_in_progress",
    });
    records.set(RUNNER, record);
    await updated();
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

  it.each([false, true])(
    "refuses a resume that returns a new session ID (reported as resumed: %s)",
    async (reportedResumed) => {
      const busy = await world.agent();
      const { sessionId } = busy;
      const row = async () =>
        (
          await pool.query("SELECT cli_session_id FROM agents WHERE id = $1", [
            busy.id,
          ])
        ).rows[0].cli_session_id;
      await world.working(busy);
      await force();
      await world.activated();
      busy.resumeFails = !reportedResumed;
      busy.sessionId = "sess_new";
      world.swap();
      // At once: the host saved the new session, so a retry can't succeed.
      await finished();
      expect(busy.alive).toBe(false);
      expect(busy.launches).toHaveLength(2);
      expect(await statusOf(busy.id)).toBe("error");
      expect(await row()).toBe(sessionId);
      expect(busy.prompts).toEqual([]);
    }
  );

  it.each([
    ["cannot be stopped", false, false],
    ["cannot be stopped, across a controller restart", false, true],
    ["can be stopped by then", true, false],
  ] as const)(
    "fails a refused resume whose host came back on another session and %s",
    async (_case, stoppable, restarted) => {
      const busy = await world.agent();
      const { sessionId } = busy;
      await world.working(busy);
      await force();
      await world.activated();
      const queued = world.prompt(busy, "held for the old session");
      let delivered = false;
      void queued.accepted.then(
        () => (delivered = true),
        () => {}
      );
      busy.resumeFails = true;
      busy.sessionId = "sess_new";
      busy.stopFails = true;
      // Act between the refused pass and the next.
      world.saved.afterWrite = () => {
        if (!world.entry(busy.id)?.failedAt) return;
        world.saved.afterWrite = undefined;
        expect(busy.alive).toBe(true);
        busy.stopFails = !stoppable;
        if (restarted) world.crash();
      };
      world.swap();
      await world.until(() => !world.saved.afterWrite);
      const stops = busy.stops;
      if (restarted) await world.restart();
      await finished();

      expect(continuations(busy)).toEqual([]);
      expect(busy.stops).toBeGreaterThan(stops);
      expect(busy.alive).toBe(!stoppable);
      const { rows } = await pool.query(
        "SELECT status, last_error, cli_session_id FROM agents WHERE id = $1",
        [busy.id]
      );
      expect(rows[0]).toEqual({
        status: "error",
        last_error:
          "Dispatch couldn't resume this agent after the runner update. Start it to continue.",
        cli_session_id: sessionId,
      });
      expect(busy.launches).toHaveLength(2);
      // Nothing reaches the other session, now or once the hold has opened.
      expect(world.holds.isHeld(RUNNER)).toBe(false);
      await world.manager.reconcileAgentStatuses();
      expect(await statusOf(busy.id)).toBe("error");
      expect(busy.prompts).toEqual([]);
      expect(delivered).toBe(false);
      const { runtime } = world.manager as any;
      expect(runtime.runnerHostSession(busy.id)).toBeUndefined();
    }
  );
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
    await pool.query("UPDATE agents SET cli_session_id = $2 WHERE id = $1", [
      changed.id,
      "different-session",
    ]);
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

  it("counts only the agents still wanted as resuming", async () => {
    const kept = await world.agent();
    const archived = await world.agent();
    const stopped = await world.agent();
    const deleted = await world.agent();
    const goesLater = await world.agent();
    await force();
    await world.activated();
    await world.manager.beginArchive(archived.id);
    await world.manager.stopAgent(stopped.id);
    await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
      deleted.id,
    ]);
    let first: number | undefined;
    world.saved.afterWrite = () => {
      if (world.attempt()?.phase !== "resuming") return;
      world.saved.afterWrite = undefined;
      first = world.attempt()!.drain!.agents.length;
      world.disconnect();
    };
    world.swap();
    await world.until(() => first !== undefined);
    expect(first).toBe(2);
    expect(world.view()?.attempt?.agents).toBe(2);

    await world.manager.beginArchive(goesLater.id);
    await world.until(() => world.view()?.attempt?.agents === 1);
    world.reconnect();
    await finished();
    resumedOnce(kept);
    for (const host of [archived, stopped, deleted, goesLater])
      expect(host.launches).toHaveLength(1);
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

describe("an agent stopped and started again during the update", () => {
  /** Runs when the first write that matches has landed, and cuts the runner off. */
  async function offlineWhen(at: () => unknown) {
    world.saved.afterWrite = () => {
      if (!at()) return;
      world.saved.afterWrite = undefined;
      world.disconnect();
    };
    world.swap();
    await world.until(() => !world.saved.afterWrite);
  }

  it.each([
    ["before it resumed", false, false],
    ["before it resumed, and its new host died", false, true],
    ["after it resumed", true, false],
  ] as const)(
    "gets neither a continuation nor a second host when stopped %s",
    async (_case, resumed, dies) => {
      const busy = await world.agent();
      await world.working(busy);
      await force();
      await world.activated();
      await offlineWhen(() =>
        resumed
          ? world.entry(busy.id)?.resumed
          : world.attempt()?.phase === "resuming"
      );
      // Only the receipt can tell: the row will look as it did.
      const rows = vi
        .spyOn(world.manager, "endedRunnerResumes")
        .mockResolvedValue([]);
      // The runner's queue is busy, and a long window outlasted the hold.
      const queue = Promise.withResolvers<void>();
      const pass = (world.coordinator as any).enqueue(
        RUNNER,
        () => queue.promise
      );
      const launched = busy.launches.length;
      await world.holds.release(RUNNER, world.attempt()!.id, "expired");
      world.reconnect();
      try {
        const { cliSessionId } = (await world.manager.getAgent(busy.id))!;
        await world.manager.stopAgent(busy.id);
        expect(await statusOf(busy.id)).toBe("stopped");
        await world.manager.startAgent(busy.id);
        expect(await world.manager.getAgent(busy.id)).toMatchObject({
          status: "running",
          cliSessionId,
        });
        expect(busy.launches).toHaveLength(launched + 1);
        if (dies) {
          busy.alive = false;
          world.disconnect();
          world.reconnect();
        }
      } finally {
        queue.resolve();
        await pass;
      }
      await finished();
      expect(busy.launches).toHaveLength(launched + 1);
      expect(continuations(busy)).toEqual([]);
      rows.mockRestore();
    }
  );

  it.each(["stop", "archive", "delete"] as const)(
    "records a %s on the receipt, and keeps it across a controller restart",
    async (action) => {
      const busy = await world.agent();
      await world.working(busy);
      await force();
      await world.activated();
      await offlineWhen(() => world.attempt()?.phase === "resuming");
      let marked = false;
      world.saved.afterWrite = () => {
        if (!world.entry(busy.id)?.ended) return;
        world.saved.afterWrite = undefined;
        marked = true;
        world.crash();
      };
      const done =
        action === "stop"
          ? world.manager.stopAgent(busy.id)
          : action === "archive"
            ? world.manager.beginArchive(busy.id)
            : // The claim a cascade delete takes.
              (world.manager as any)
                .archiveDeps()
                .claimArchive(busy.id, async () => true);
      await done.catch(() => {});
      expect(marked).toBe(true);
      // Whatever the row says by then, as after a start.
      await pool.query("UPDATE agents SET status = 'running' WHERE id = $1", [
        busy.id,
      ]);
      world.reconnect();
      await world.restart();
      await finished();
      expect(busy.launches).toHaveLength(1);
      expect(continuations(busy)).toEqual([]);
    }
  );

  it.each(["launch", "continuation"] as const)(
    "refuses a %s that was chosen before the stop was recorded",
    async (step) => {
      const busy = await world.agent();
      await world.working(busy);
      await force();
      await world.activated();
      vi.spyOn(world.manager, "endedRunnerResumes").mockResolvedValue([]);
      const ended = () => (world.coordinator as any).endResume(busy.id);
      if (step === "launch") {
        const resume = world.manager.resumeRunnerDrainHost.bind(world.manager);
        world.manager.resumeRunnerDrainHost = async (...args) => {
          await ended();
          return resume(...args);
        };
      } else {
        const sessions = world.manager.runnerForce;
        const tell = sessions.continue.bind(sessions);
        sessions.continue = async (...args) => {
          await ended();
          return tell(...args);
        };
      }
      world.swap();
      await finished();
      expect(busy.launches).toHaveLength(step === "launch" ? 1 : 2);
      expect(continuations(busy)).toEqual([]);
    }
  );

  it("leaves an ended entry out when a drain becomes a forced update", async () => {
    world.runner.incompatible = true;
    const drained = await world.agent();
    const blocker = await world.agent();
    await world.working(blocker);
    const { attemptId } = await world.coordinator.request(RUNNER, "update");
    await world.until(() => !drained.alive && world.entry(drained.id));
    let after: unknown = "not saved";
    await world.holds.wait(RUNNER, "stop");
    await (world.coordinator as any).endResume(drained.id);
    world.saved.afterWrite = () => {
      if (world.attempt()?.phase !== "interrupting") return;
      world.saved.afterWrite = undefined;
      after = world.entry(drained.id);
    };
    await world.coordinator.forceUpdate(RUNNER, attemptId);
    expect(after).toBeUndefined();
  });

  it("keeps the mark through a write built before it", async () => {
    const busy = await world.agent();
    await world.working(busy);
    await force();
    await world.activated();
    const coordinator = world.coordinator as any;
    const stale = structuredClone(coordinator.records.get(RUNNER));
    await coordinator.endResume(busy.id);
    await coordinator.save(stale);
    expect(world.entry(busy.id)?.ended).toBe(true);
    world.swap();
    await finished();
    expect(busy.launches).toHaveLength(1);
    expect(continuations(busy)).toEqual([]);
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
    world.holds.setStopPhase(RUNNER, waiting, "draining");
    await stop;
    expect(await statusOf(busy.id)).toBe("stopped");
    expect(world.holds.isHeld(RUNNER)).toBe(true);

    // Fenced again: the next one waits.
    world.holds.setStopPhase(RUNNER, waiting, undefined);
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

  it.each(["drain", "force"] as const)(
    "completes Stop and Archive during offline %s recovery without resuming either agent",
    async (path) => {
      const stopped = await world.agent();
      const archived = await world.agent();
      const kept = await world.agent();
      if (path === "force") {
        for (const host of [stopped, archived, kept]) await world.working(host);
        await force();
      } else {
        world.runner.incompatible = true;
        await world.coordinator.request(RUNNER, "update");
      }
      await world.activated();
      world.saved.afterWrite = () => {
        if (world.attempt()?.phase !== "resuming") return;
        world.saved.afterWrite = undefined;
        world.disconnect();
      };
      world.swap();
      await world.until(() => world.view()?.attempt?.phase === "resuming");
      expect(world.view()?.attempt?.agents).toBe(3);

      const stop = world.manager.stopAgent(stopped.id);
      await world.manager.beginArchive(archived.id, "keep");
      let deleted: string[] | undefined;
      const archive = world.manager.executeArchive(archived.id, {
        onPhaseChange() {},
        onComplete(ids) {
          deleted = ids;
        },
        onError(error) {
          throw error;
        },
      });
      try {
        await world.until(
          async () =>
            deleted !== undefined && (await statusOf(stopped.id)) === "stopped",
          2_000
        );
        expect(deleted).toEqual([archived.id]);
        expect(await world.manager.getAgent(archived.id)).toBeNull();
        await world.until(() => world.view()?.attempt?.agents === 1);
        expect(world.holds.isHeld(RUNNER)).toBe(true);
        expect(world.entry(stopped.id)).toBeUndefined();
        expect(world.entry(archived.id)).toBeUndefined();
      } finally {
        world.reconnect();
        await finished();
        await Promise.allSettled([stop, archive]);
      }
      expect((await stop).status).toBe("stopped");
      await archive;
      resumedOnce(kept);
      expect(continuations(kept)).toHaveLength(path === "force" ? 1 : 0);
      for (const host of [stopped, archived]) {
        expect(host.alive).toBe(false);
        expect(host.launches).toHaveLength(1);
        expect(host.prompts).toEqual([]);
      }
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

  it.each(["drain", "force"] as const)(
    "resumes and continues the right session after a rename during %s",
    async (path) => {
      const renamed = await world.agent();
      if (path === "force") {
        await world.working(renamed);
        await force();
      } else {
        world.runner.incompatible = true;
        await world.coordinator.request(RUNNER, "update");
      }
      await world.activated();
      await pool.query(
        "UPDATE agents SET name = 'Renamed', updated_at = clock_timestamp() WHERE id = $1",
        [renamed.id]
      );
      world.swap();
      await finished();
      resumedOnce(renamed);
      expect(continuations(renamed)).toHaveLength(path === "force" ? 1 : 0);
    }
  );

  it.each([
    "status = 'stopped'",
    "status = 'archived'",
    "deleted_at = now()",
    "runner_id = 'another'",
    "cli_session_id = 'other-session'",
  ])("drops the resume when %s", async (edit) => {
    const host = await world.agent();
    await world.working(host);
    await force();
    await world.activated();
    await pool.query(`UPDATE agents SET ${edit} WHERE id = $1`, [host.id]);
    world.swap();
    await finished();
    expect(host.launches).toHaveLength(1);
    expect(continuations(host)).toHaveLength(0);
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

const updatePaths = ["live", "drain", "force"] as const;
type UpdatePath = (typeof updatePaths)[number];

async function startUpdate(path: UpdatePath) {
  world.runner.incompatible = path === "drain";
  return path === "force"
    ? force()
    : world.coordinator.request(RUNNER, "update");
}

async function swapOverNewConnection(attemptId: string) {
  world.disconnect();
  world.reconnect(attemptId);
  world.swap();
  await finished();
}

async function runningInOriginalSession(host: Host) {
  // A successful launch reply precedes the manager's running-row update.
  await world.until(async () => (await statusOf(host.id)) === "running");
  expect(await world.manager.getAgent(host.id)).toMatchObject({
    status: "running",
    cliSessionId: host.sessionId,
  });
}

function recoveredOnce(host: Host, path: UpdatePath) {
  if (path !== "live") return resumedOnce(host);
  expect(host.launches.slice(1)).toEqual([
    { launchId: expect.any(String), resume: host.sessionId },
  ]);
  expect(host.launches[1]!.launchId).not.toBe(host.launches[0]!.launchId);
}

describe("runner update scenarios", () => {
  it.each(updatePaths)(
    "delivers a long turn once and preserves its session through %s",
    async (path) => {
      const remote = await world.agent();
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      remote.openPrompt = marker;
      await world.prompt(remote, marker).accepted;
      await world.recorded();
      const turn = remote.turn!.seq;
      const instance = remote.instanceId;

      const { attemptId } = await startUpdate(path);
      await world.until(() => world.holds.isHeld(RUNNER));
      await local.assertContinues(`local-${marker}`);
      if (path === "drain") {
        await world.until(() => world.view()?.attempt?.phase === "draining");
        expect(world.view()?.attempt?.agents).toBe(1);
        expect(world.effects).not.toContain("activate");
        remote.settle();
      }
      await world.activated();
      await swapOverNewConnection(attemptId);

      if (path === "live") {
        expect(remote.instanceId).toBe(instance);
        expect(remote.turn?.seq).toBe(turn);
        expect(remote.launches).toHaveLength(1);
        remote.settle();
        await world.until(() => remote.launches.length === 2);
      }
      await world.recorded();
      await runningInOriginalSession(remote);
      recoveredOnce(remote, path);
      expect(remote.interrupts).toEqual(path === "force" ? [turn] : []);
      expect(continuations(remote).map(({ id }) => id)).toEqual(
        path === "force" ? [continuationId(attemptId, remote.id)] : []
      );
      expect(remote.prompts.filter(({ text }) => text === marker)).toHaveLength(
        1
      );
      expect(
        remote.journal.filter(
          ({ event }) =>
            event.type === "turn" &&
            event.state === "started" &&
            event.text === marker
        )
      ).toHaveLength(1);
      const originalTurn = remote.journal.slice(turn - 1);
      const nextTurn = originalTurn.findIndex(
        ({ event }, index) =>
          index > 0 && event.type === "turn" && event.state === "started"
      );
      const originalSettlements = (
        nextTurn === -1 ? originalTurn : originalTurn.slice(0, nextTurn)
      ).flatMap(({ event }) =>
        event.type === "turn" && event.state === "settled"
          ? [event.stopReason]
          : []
      );
      expect(originalSettlements).toEqual([
        path === "force" ? "cancelled" : "end_turn",
      ]);
    }
  );

  it.each(updatePaths)(
    "delivers an awaited child reply once to the original parent session through %s",
    async (path) => {
      const parent = await world.agent();
      const child = await world.agent();
      // Seed the persisted relationship used to protect a waiting parent.
      // The standalone launcher cannot create a child on this workspace.
      await pool.query("UPDATE agents SET parent_agent_id = $1 WHERE id = $2", [
        parent.id,
        child.id,
      ]);
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      const turn = await world.working(parent);
      await world.working(child);
      const originalInstance = parent.instanceId;
      const reply = () =>
        world.manager.promptAgent(
          parent.id,
          marker,
          {
            source: "agent",
            senderId: child.id,
            senderName: "Child",
            text: marker,
            awaited: true,
          },
          { delivery: "auto" }
        );

      const { attemptId } = await startUpdate(path);
      await world.until(() => world.holds.isHeld(RUNNER));
      await local.assertContinues(`local-${marker}`);
      if (path === "drain") {
        await world.until(() => world.view()?.attempt?.agents === 2);
        child.settle();
        const delivered = reply();
        await world.until(() => parent.prompts.length === 1);
        await delivered.settled;
        expect(parent.instanceId).toBe(originalInstance);
      }
      await world.activated();
      const queued = path === "force" ? reply() : undefined;
      await swapOverNewConnection(attemptId);
      if (path === "live") {
        expect(parent.instanceId).toBe(originalInstance);
        expect(parent.turn?.seq).toBe(turn);
        expect(child.alive).toBe(true);
        child.settle();
        const delivered = reply();
        await world.until(() => parent.prompts.length === 1);
        await delivered.settled;
        expect(parent.instanceId).toBe(originalInstance);
        await world.manager.stopAgent(child.id);
        await world.until(() => parent.launches.length === 2);
      }
      if (queued) {
        await world.until(() => parent.prompts.length === 2);
        await queued.settled;
      }
      await world.recorded();
      recoveredOnce(parent, path);
      expect(parent.prompts.map(({ text }) => text)).toEqual(
        path === "force" ? [UPDATE_CONTINUATION_MESSAGE, marker] : [marker]
      );
      expect(parent.prompts.at(-1)?.source).toMatchObject({
        source: "agent",
        senderId: child.id,
      });
      expect(parent.interrupts).toEqual(path === "force" ? [turn] : []);
      await runningInOriginalSession(parent);
      if (path === "live") expect(await statusOf(child.id)).toBe("stopped");
      else await runningInOriginalSession(child);
    }
  );

  it.each(updatePaths)(
    "preserves a held launch ID and starts its host once after %s recovery",
    async (path) => {
      const prior = await world.agent();
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      if (path === "drain") await world.working(prior);
      const { attemptId } = await startUpdate(path);
      if (path === "drain") {
        await world.until(() => world.view()?.attempt?.agents === 1);
      } else {
        await world.activated();
      }
      const queued = await world.manager.createAgent({
        cwd: `runner://${RUNNER}/@session`,
        initialPrompt: marker,
      });
      const [{ launchId }] = world.holds.current(RUNNER)!.launches;
      expect(world.hosts.get(queued.id)?.launches ?? []).toEqual([]);
      await local.assertContinues(`local-${marker}`);
      if (path === "drain") {
        expect(world.hosts.get(queued.id)?.launches ?? []).toEqual([]);
        prior.settle();
        await world.activated();
      }

      await swapOverNewConnection(attemptId);
      await world.until(
        async () =>
          world.hosts.get(queued.id)?.prompts.length &&
          (await statusOf(queued.id)) === "running"
      );
      const launched = world.hosts.get(queued.id)!;
      expect(launched.launches).toEqual([{ launchId, resume: null }]);
      expect(launched.prompts.map(({ text }) => text)).toEqual([marker]);
      await runningInOriginalSession(launched);
      if (path === "live") {
        await world.until(() => prior.launches.length === 2);
      } else {
        expect(world.effects.lastIndexOf(`launch:${prior.id}`)).toBeLessThan(
          world.effects.indexOf(`launch:${queued.id}`)
        );
      }
      await runningInOriginalSession(prior);
      recoveredOnce(prior, path);
    }
  );

  it.each(updatePaths)(
    "retains or resumes the original session exactly once after a failed %s trial",
    async (path) => {
      const remote = await world.agent();
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      const instance = remote.instanceId;
      if (path === "force") await world.working(remote);
      const { attemptId } = await startUpdate(path);
      await world.activated();
      const held = world.prompt(remote, marker);
      expect(remote.prompts).toEqual([]);
      await local.assertContinues(`local-${marker}`);
      world.rollBack();
      await finished("rolled_back");
      await held.accepted;
      if (path === "live") {
        expect(remote.instanceId).toBe(instance);
        expect(remote.launches).toHaveLength(1);
      } else {
        resumedOnce(remote);
      }
      expect(continuations(remote).map(({ id }) => id)).toEqual(
        path === "force" ? [continuationId(attemptId, remote.id)] : []
      );
      expect(remote.prompts.filter(({ text }) => text === marker)).toHaveLength(
        1
      );
      await runningInOriginalSession(remote);
      expect(world.holds.isHeld(RUNNER)).toBe(false);
    }
  );

  it.each(updatePaths)(
    "keeps held work scoped over two runner disconnects during %s",
    async (path) => {
      const remote = await world.agent();
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      const seq = await world.working(remote);
      const instance = remote.instanceId;
      const { attemptId } = await startUpdate(path);
      if (path === "drain") {
        await world.until(() => world.view()?.attempt?.agents === 1);
      } else {
        await world.activated();
      }
      const held = world.prompt(remote, marker);
      world.disconnect();
      await world.coordinator.tick();
      expect(world.holds.isHeld(RUNNER)).toBe(true);
      expect(remote.prompts).toEqual([]);
      await local.assertContinues(`local-${marker}`);

      world.reconnect(path === "drain" ? undefined : attemptId);
      if (path === "drain") {
        expect(world.view()?.attempt?.phase).toBe("draining");
        expect(world.view()?.attempt?.agents).toBe(1);
        remote.settle();
        await world.activated();
      }

      world.saved.afterWrite = () => {
        if (world.attempt()?.phase !== "confirming") return;
        world.saved.afterWrite = undefined;
        world.disconnect();
      };
      world.swap();
      await world.until(() => !world.saved.afterWrite);
      expect(world.holds.isHeld(RUNNER)).toBe(true);
      expect(remote.launches).toHaveLength(1);
      expect(remote.prompts).toEqual([]);
      world.reconnect(attemptId);
      world.swap();
      await finished();

      if (path === "live") {
        expect(remote.instanceId).toBe(instance);
        expect(remote.turn?.seq).toBe(seq);
        remote.settle();
      }
      await held.accepted;
      await runningInOriginalSession(remote);
      if (path !== "live") resumedOnce(remote);
      expect(remote.interrupts).toEqual(path === "force" ? [seq] : []);
      expect(remote.prompts.map(({ text }) => text)).toEqual(
        path === "force" ? [UPDATE_CONTINUATION_MESSAGE, marker] : [marker]
      );
    }
  );

  it.each(updatePaths)(
    "serves the same session with an older schema-aware controller after %s",
    async (path) => {
      const remote = await world.agent({ recyclable: path !== "live" });
      const local = await world.localAgent();
      const marker = crypto.randomUUID();
      if (path !== "drain") await world.working(remote);
      const { attemptId } = await startUpdate(path);
      await world.activated();
      await local.assertContinues(`local-before-${marker}`);
      await swapOverNewConnection(attemptId);
      const instance = remote.instanceId;
      const launches = [...remote.launches];
      expect(world.attempt()?.drain).toBeUndefined();
      const frameCount = world.runner.frames.length;

      await world.restart({ olderBuild: true });
      await world.until(() => !world.holds.isHeld(RUNNER));
      if (path === "live") remote.settle();
      await world.prompt(remote, marker).accepted;
      await local.assertContinues(`local-after-${marker}`);
      expect(world.runner.frames.slice(frameCount)).toEqual([]);
      expect(world.view()?.available).toBeUndefined();
      expect(world.attempt()?.drain).toBeUndefined();
      expect(remote.instanceId).toBe(instance);
      expect(remote.launches).toEqual(launches);
      expect(remote.prompts.map(({ text }) => text)).toEqual(
        path === "force" ? [UPDATE_CONTINUATION_MESSAGE, marker] : [marker]
      );
      await runningInOriginalSession(remote);
    }
  );
});
