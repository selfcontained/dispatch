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
