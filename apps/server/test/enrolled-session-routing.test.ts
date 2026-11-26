import { describe, expect, it, vi } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import type { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { withSessionPeer } from "../src/runners/enrolled/connection.js";

function peer(epoch: number) {
  return {
    epoch,
    approved: () => true,
    connection: {
      connected: true,
      call: vi.fn(),
    } as unknown as LocalSocketConnection,
  };
}

describe("authenticated runner placement", () => {
  const session = sessionFromWire("agt_session");
  const source = sessionFromWire("agt_source");
  const owns = async (runnerId: string, ids: string[]) =>
    ids.every((id) => id === "agt_session" && runnerId === "a");

  it("checks direct, borrowed, target and sampled sessions before writing to either peer", async () => {
    const a = peer(1),
      b = peer(2);
    const write = vi.fn();
    await expect(
      withSessionPeer(
        "b",
        "session.stop",
        { session, force: true },
        () => b,
        owns,
        write
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      withSessionPeer(
        "b",
        "checkout.watch",
        { target: { session } },
        () => b,
        owns,
        write
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      withSessionPeer(
        "a",
        "session.sample",
        { sessions: [session, source] },
        () => a,
        owns,
        write
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      withSessionPeer(
        "a",
        "workspace.prepare",
        {
          session,
          source: { session: source },
          copyIgnored: [],
          installDependencies: false,
        },
        () => a,
        owns,
        write
      )
    ).rejects.toMatchObject({ code: "not_found" });
    expect(write).not.toHaveBeenCalled();
    await withSessionPeer(
      "a",
      "session.alive",
      { session },
      () => a,
      owns,
      write
    );
    expect(write.mock.calls).toEqual([[a.connection]]);
  });

  it("rejects replacement of a peer during the placement lookup without writing or retrying", async () => {
    let current = peer(1);
    const write = vi.fn();
    await expect(
      withSessionPeer(
        "a",
        "session.stop",
        { session, force: true },
        () => current,
        async () => {
          current = peer(2);
          return true;
        },
        write
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(write).not.toHaveBeenCalled();
  });
});

it("takes identity from the authenticated registration and samples after the description", async () => {
  const { Duplex, PassThrough } = await import("node:stream");
  const { wireFrames } = await import("@dispatch/runner-client/v1/node");
  const { RUNNER_WIRE_VERSION } = await import("@dispatch/runner-protocol");
  const { attachAuthenticatedRunner } =
    await import("../src/runners/enrolled/operation-peer.js");
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const controller = Duplex.from({ readable: incoming, writable: outgoing });
  const runner = Duplex.from({ readable: outgoing, writable: incoming });
  const ops: string[] = [];
  const sample = {
    version: "1",
    sessions: 0,
    working: 0,
    cpuPercent: null,
    memoryUsed: 0,
    memoryTotal: 1,
  };
  const send = wireFrames<{ id: number; op: string; input: unknown }>(
    runner,
    (frame) => {
      ops.push(frame.op);
      const value =
        frame.op === "runner.describe"
          ? {
              runnerId: "spoof",
              displayName: "frame",
              build: { version: "1" },
              protocol: RUNNER_WIRE_VERSION,
              engines: [],
              capabilities: {},
            }
          : frame.op === "runner.health"
            ? sample
            : { entries: [] };
      if (frame.op === "engine.list")
        expect(frame.input).toEqual({ refresh: false, background: true });
      send({ id: frame.id, ok: true, value });
    }
  );
  const connected = vi.fn();
  const health = Promise.withResolvers<unknown>(),
    inventory = Promise.withResolvers<unknown>();
  const connection = attachAuthenticatedRunner(
    controller,
    { id: "authenticated", name: "Registration", approved: () => true },
    17,
    {
      connected,
      current: () => true,
      disconnected: vi.fn(),
      status: vi.fn(),
      health: (_peer, value) => health.resolve(value),
      inventory: (_peer, value) => inventory.resolve(value),
    }
  );
  try {
    await expect(health.promise).resolves.toEqual(sample);
    await expect(inventory.promise).resolves.toEqual([]);
    expect(connected).toHaveBeenCalledWith(
      expect.objectContaining({
        epoch: 17,
        description: expect.objectContaining({
          runnerId: "authenticated",
          displayName: "Registration",
        }),
      })
    );
    expect(ops).toEqual(["runner.describe", "runner.health", "engine.list"]);
  } finally {
    const closed = Promise.all(
      [controller, runner].map(
        (socket) =>
          new Promise<void>((resolve) => socket.once("close", resolve))
      )
    );
    controller.end();
    runner.end();
    await closed;
  }
});
