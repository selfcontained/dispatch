import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { InjectionCoordinator } from "../src/terminal/injection-coordinator.js";

const QUIET_MS = 40;
const MAX_WAIT_MS = 200;

function makeCoordinator(): InjectionCoordinator {
  return new InjectionCoordinator({
    quietMs: QUIET_MS,
    maxWaitMs: MAX_WAIT_MS,
  });
}

describe("InjectionCoordinator", () => {
  it("injects immediately when there is no user activity", async () => {
    const coordinator = makeCoordinator();
    const start = Date.now();
    const result = await coordinator.inject("a1", async () => "done");
    expect(result).toBe("done");
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
  });

  it("defers injection until the activity signal is quiet", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("a1");
    const start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(QUIET_MS - 5);
  });

  it("keeps deferring while activity continues, up to the cap", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("a1");
    const typing = (async () => {
      for (let i = 0; i < 30; i += 1) {
        await delay(10);
        coordinator.noteUserActivity("a1");
      }
    })();
    const start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(MAX_WAIT_MS - 10);
    expect(waited).toBeLessThan(MAX_WAIT_MS + 100);
    await typing;
  });

  it("does not defer for activity on a different agent", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("other");
    const start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
  });

  it("serializes injections per agent in FIFO order", async () => {
    const coordinator = makeCoordinator();
    const order: string[] = [];
    let firstRunning = false;
    const first = coordinator.inject("a1", async () => {
      firstRunning = true;
      await delay(30);
      firstRunning = false;
      order.push("first");
    });
    const second = coordinator.inject("a1", async () => {
      expect(firstRunning).toBe(false);
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs injections for different agents concurrently", async () => {
    const coordinator = makeCoordinator();
    let firstRunning = false;
    let sawOverlap = false;
    const first = coordinator.inject("a1", async () => {
      firstRunning = true;
      await delay(30);
      firstRunning = false;
    });
    const second = coordinator.inject("a2", async () => {
      sawOverlap = firstRunning;
    });
    await Promise.all([first, second]);
    expect(sawOverlap).toBe(true);
  });

  it("skips the quiet gate with gate: false", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("a1");
    const start = Date.now();
    await coordinator.inject("a1", async () => undefined, { gate: false });
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
  });

  it("does not queue ungated injections behind a gate-held injection", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("a1");
    const order: string[] = [];
    const gated = coordinator.inject("a1", async () => {
      order.push("gated");
    });
    await delay(5);
    // The gated injection is parked at the quiet gate; the user-initiated
    // one must run immediately instead of waiting out the hold.
    const start = Date.now();
    await coordinator.inject(
      "a1",
      async () => {
        order.push("ungated");
      },
      { gate: false }
    );
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
    expect(order).toEqual(["ungated"]);
    await gated;
    expect(order).toEqual(["ungated", "gated"]);
  });

  it("ungated injections still serialize against an active pane write", async () => {
    const coordinator = makeCoordinator();
    let writing = false;
    let sawOverlap = false;
    const first = coordinator.inject(
      "a1",
      async () => {
        writing = true;
        await delay(30);
        writing = false;
      },
      { gate: false }
    );
    const second = coordinator.inject(
      "a1",
      async () => {
        sawOverlap = writing;
      },
      { gate: false }
    );
    await Promise.all([first, second]);
    expect(sawOverlap).toBe(false);
  });

  it("reports hold state transitions while deferring", async () => {
    const events: Array<{ held: boolean; pendingCount: number }> = [];
    const coordinator = new InjectionCoordinator({
      quietMs: QUIET_MS,
      maxWaitMs: MAX_WAIT_MS,
      onHoldChange: (agentId, state) => {
        expect(agentId).toBe("a1");
        events.push(state);
      },
    });
    coordinator.noteUserActivity("a1");
    await coordinator.inject("a1", async () => undefined);
    await delay(0);
    // enqueue → hold begins → hold ends → delivered
    expect(events[0]).toEqual({
      held: false,
      pendingCount: 1,
      quietMs: QUIET_MS,
    });
    expect(events[1]).toEqual({
      held: true,
      pendingCount: 1,
      quietMs: QUIET_MS,
    });
    expect(events[2]).toEqual({
      held: false,
      pendingCount: 1,
      quietMs: QUIET_MS,
    });
    expect(events.at(-1)).toEqual({
      held: false,
      pendingCount: 0,
      quietMs: QUIET_MS,
    });
    expect(coordinator.holdState("a1")).toEqual({
      held: false,
      pendingCount: 0,
      quietMs: QUIET_MS,
    });
  });

  it("releaseHold delivers a held injection immediately", async () => {
    const coordinator = makeCoordinator();
    coordinator.noteUserActivity("a1");
    const start = Date.now();
    const delivery = coordinator.inject("a1", async () => "sent");
    // Let the injection enter its hold, then release it well before quiet.
    await delay(10);
    coordinator.releaseHold("a1");
    const result = await delivery;
    expect(result).toBe("sent");
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
  });

  it("releaseHold does not exempt injections enqueued afterwards", async () => {
    const coordinator = makeCoordinator();
    coordinator.releaseHold("a1");
    coordinator.noteUserActivity("a1");
    const start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(QUIET_MS - 5);
  });

  it("does not report a hold when delivery is immediate", async () => {
    const holds: boolean[] = [];
    const coordinator = new InjectionCoordinator({
      quietMs: QUIET_MS,
      maxWaitMs: MAX_WAIT_MS,
      onHoldChange: (_agentId, state) => holds.push(state.held),
    });
    await coordinator.inject("a1", async () => undefined);
    await delay(0);
    expect(holds).toEqual([false, false]);
  });

  it("skips the quiet gate entirely when gateEnabled returns false", async () => {
    const holds: boolean[] = [];
    const coordinator = new InjectionCoordinator({
      quietMs: QUIET_MS,
      maxWaitMs: MAX_WAIT_MS,
      gateEnabled: () => false,
      onHoldChange: (_agentId, state) => holds.push(state.held),
    });
    coordinator.noteUserActivity("a1");
    const start = Date.now();
    const result = await coordinator.inject("a1", async () => "sent");
    expect(result).toBe("sent");
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
    // No pending/hold events at all — the badge never appears.
    expect(holds).toEqual([]);
  });

  it("re-evaluates gateEnabled on every injection (live toggling)", async () => {
    let on = false;
    const coordinator = new InjectionCoordinator({
      quietMs: QUIET_MS,
      maxWaitMs: MAX_WAIT_MS,
      gateEnabled: () => on,
    });
    coordinator.noteUserActivity("a1");
    let start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeLessThan(QUIET_MS);

    on = true;
    coordinator.noteUserActivity("a1");
    start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(QUIET_MS - 5);

    on = false;
    coordinator.noteUserActivity("a1");
    start = Date.now();
    await coordinator.inject("a1", async () => undefined);
    expect(Date.now() - start).toBeLessThan(QUIET_MS);
  });

  it("propagates task errors without blocking later injections", async () => {
    const coordinator = makeCoordinator();
    await expect(
      coordinator.inject("a1", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const result = await coordinator.inject("a1", async () => "ok");
    expect(result).toBe("ok");
  });
});
