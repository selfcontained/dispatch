import { afterEach, expect, it, vi } from "vitest";
import {
  RunnerUpdateCoordinator,
  UPDATE_TIMING,
  type RunnerUpdateRecord,
} from "../src/agents/remote/update-coordinator.js";
import type { RunnerUpdateEvent } from "../src/agents/remote/service.js";
import { identity, target } from "./runner-update-fixtures.js";

const build = (version: string) => ({ version, revision: target.revision });

let coordinator: RunnerUpdateCoordinator | undefined;
afterEach(() => coordinator?.close());

async function scheduler() {
  let now = Date.now();
  let records: RunnerUpdateRecord[] = [];
  const peers = new Map<string, { epoch: number; version: string }>();
  const wanted = build(target.version);
  let receive: (event: RunnerUpdateEvent) => void;
  const offer = vi.fn();
  const cancel = vi.fn();
  coordinator = new RunnerUpdateCoordinator({
    build: wanted,
    now: () => now,
    store: {
      read: async () => records,
      async write(next) {
        records = next;
      },
    },
    service: {
      connectedRunnerIds: () => [...peers.keys()],
      automaticUpdates: () => true,
      isRegistered: () => true,
      connectionEpoch: (id: string) => peers.get(id)?.epoch,
      selfUpdate: (id: string) => {
        const peer = peers.get(id);
        return peer && { epoch: peer.epoch, advert: { ...identity, ...peer } };
      },
      onConnectionChange: () => () => {},
      onUpdateStatus(listener: typeof receive) {
        receive = listener;
        return () => {};
      },
      offerUpdate: offer,
      cancelUpdate: cancel,
    } as never,
    holds: {
      setStopPhase() {},
      current: () => undefined,
      release: async () => {},
    } as never,
    agents: {
      settleRunnerHostRecycling: async () => {},
      onRunnerResumeEnded: () => () => {},
    } as never,
    artifacts: () =>
      ({
        updateEnabled: true,
        getUpdate: async () => ({
          manifest: { version: wanted.version, sha256: target.sha256 },
        }),
      }) as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await coordinator.load();
  await coordinator.start();
  const runner = coordinator;
  return {
    peers,
    offer,
    cancel,
    wanted,
    async tick(ms = 0) {
      now += ms;
      await runner.tick();
    },
    send(runnerId: string, phase: "deferred" | "rolled_back", reason: string) {
      receive({
        runnerId,
        epoch: peers.get(runnerId)!.epoch,
        status: {
          type: "update_status",
          attemptId: records.find((row) => row.runnerId === runnerId)!.attempt
            .id,
          phase,
          reason,
          installed: identity,
        },
      } as RunnerUpdateEvent);
    },
    async terminal(runnerId: string) {
      await vi.waitFor(async () => {
        await runner.tick();
        expect(
          records.find((row) => row.runnerId === runnerId)?.attempt.outcome
        ).toBeDefined();
      });
    },
  };
}

it("settles before offering and staggers across two runners", async () => {
  const world = await scheduler();
  world.peers.set("a", { epoch: 1, version: identity.version });
  world.peers.set("b", { epoch: 2, version: identity.version });
  await world.tick(UPDATE_TIMING.automaticSettleMs - 1);
  expect(world.offer).not.toHaveBeenCalled();
  await world.tick(1);
  expect(world.offer.mock.calls.map(([id]) => id)).toEqual(["a"]);
  await world.tick(UPDATE_TIMING.automaticSpacingMs);
  expect(world.offer).toHaveBeenCalledTimes(1);
  world.send("a", "rolled_back", "boot_failed");
  await world.terminal("a");
  await world.tick();
  expect(world.offer.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
});

it("offers only the current build after an offline runner misses three targets", async () => {
  const world = await scheduler();
  for (const version of ["3.0.0", "4.0.0", "5.0.0"]) {
    world.wanted.version = version;
    await world.tick(UPDATE_TIMING.automaticSettleMs);
  }
  expect(world.offer).not.toHaveBeenCalled();
  world.peers.set("a", { epoch: 1, version: identity.version });
  await world.tick();
  expect(world.offer).toHaveBeenCalledTimes(1);
  expect(world.offer.mock.calls[0]?.[2].version).toBe("5.0.0");
  // Change the wanted build again while the previous offer is still staged.
  world.wanted.version = "6.0.0";
  await world.tick(UPDATE_TIMING.automaticSpacingMs);
  expect(world.cancel).toHaveBeenCalledTimes(1);
  world.send("a", "deferred", "cancelled");
  await world.terminal("a");
  await world.tick();
  expect(
    world.offer.mock.calls.map(([, , offered]) => offered.version)
  ).toEqual(["5.0.0", "6.0.0"]);
});

it("never offers the same build or a downgrade", async () => {
  const world = await scheduler();
  world.peers.set("same", { epoch: 1, version: target.version });
  world.peers.set("newer", { epoch: 2, version: "99.0.0" });
  await world.tick(UPDATE_TIMING.automaticSettleMs);
  expect(world.offer).not.toHaveBeenCalled();
});

it("offers the next target after a failed one", async () => {
  const world = await scheduler();
  world.peers.set("a", { epoch: 1, version: identity.version });
  await world.tick(UPDATE_TIMING.automaticSettleMs);
  world.send("a", "rolled_back", "boot_failed");
  await world.terminal("a");
  await world.tick(UPDATE_TIMING.automaticSpacingMs);
  expect(world.offer).toHaveBeenCalledTimes(1);
  world.wanted.version = "5.0.0";
  await world.tick(UPDATE_TIMING.automaticSpacingMs);
  expect(
    world.offer.mock.calls.map(([, , offered]) => offered.version)
  ).toEqual([target.version, "5.0.0"]);
});
