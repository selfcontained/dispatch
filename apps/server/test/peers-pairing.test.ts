import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  claimPairing,
  createPairingOffer,
  linkToPeer,
  listPeers,
  revokePeer,
} from "../src/peers/pairing.js";
import { requirePeerAuth } from "../src/peers/peer-auth.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

function claimer(id: string) {
  return {
    instanceId: id,
    name: `Peer ${id}`,
    url: `http://${id}.example:6767`,
    token: `reverse-token-${id}-${"x".repeat(24)}`,
  };
}

describe("pairing claim", () => {
  it("accepts a valid code once and registers the peer with both credentials", async () => {
    const offer = await createPairingOffer(pool, {
      allowLaunch: true,
      requireTailnet: false,
    });
    const result = await claimPairing(
      pool,
      { code: offer.code, claimer: claimer("inst_aaa"), callerAddr: null },
      "acceptor-name"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("acceptor-name");
    expect(result.token.length).toBeGreaterThan(30);

    const peers = await listPeers(pool);
    const peer = peers.find((p) => p.id === "inst_aaa");
    expect(peer).toMatchObject({
      name: "Peer inst_aaa",
      url: "http://inst_aaa.example:6767",
      allowLaunch: true,
    });

    // Single use: the same code is dead after a successful claim.
    const replay = await claimPairing(
      pool,
      { code: offer.code, claimer: claimer("inst_bbb"), callerAddr: null },
      "acceptor-name"
    );
    expect(replay).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects an unknown code", async () => {
    const result = await claimPairing(
      pool,
      { code: "000000", claimer: claimer("inst_ccc"), callerAddr: null },
      "acceptor-name"
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("hard-denies a tailnet-required offer when the caller has no tailnet identity", async () => {
    const offer = await createPairingOffer(pool, {
      allowLaunch: true,
      requireTailnet: true,
    });
    const result = await claimPairing(
      pool,
      { code: offer.code, claimer: claimer("inst_ddd"), callerAddr: null },
      "acceptor-name"
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("carries the offer's launch policy onto the issued credential", async () => {
    const offer = await createPairingOffer(pool, {
      allowLaunch: false,
      requireTailnet: false,
    });
    const result = await claimPairing(
      pool,
      { code: offer.code, claimer: claimer("inst_eee"), callerAddr: null },
      "acceptor-name"
    );
    expect(result.ok).toBe(true);
    const peers = await listPeers(pool);
    expect(peers.find((p) => p.id === "inst_eee")?.allowLaunch).toBe(false);
  });
});

describe("linkToPeer", () => {
  it("stores both directions after a successful remote claim", async () => {
    const remoteToken = `accepted-token-${"y".repeat(24)}`;
    let claimedBody: unknown;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      claimedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          instanceId: "inst_remote",
          name: "cloud-vm",
          token: remoteToken,
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await linkToPeer(
      pool,
      {
        address: "127.0.0.1:6767",
        code: "123456",
        allowLaunch: true,
        selfUrl: "http://laptop.example:6767",
      },
      { instanceName: "laptop", port: 6767, fetchImpl }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peer).toMatchObject({
      id: "inst_remote",
      name: "cloud-vm",
      url: "http://127.0.0.1:6767",
    });

    // The reverse credential we minted went over the wire...
    const sent = claimedBody as {
      code: string;
      instance: { token: string; url: string };
    };
    expect(sent.code).toBe("123456");
    expect(sent.instance.url).toBe("http://laptop.example:6767");

    // ...and its hash is what authenticates the peer when it calls back.
    const peers = await listPeers(pool);
    expect(peers.some((p) => p.id === "inst_remote")).toBe(true);
  });

  it("surfaces the remote error body on a failed claim", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Invalid or expired code." }), {
        status: 401,
      })) as typeof fetch;
    const result = await linkToPeer(
      pool,
      {
        address: "127.0.0.1:6767",
        code: "999999",
        allowLaunch: true,
        selfUrl: "http://laptop.example:6767",
      },
      { instanceName: "laptop", port: 6767, fetchImpl }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      error: "Invalid or expired code.",
    });
  });
});

describe("requirePeerAuth", () => {
  function fakeReply() {
    const state: { code?: number; body?: unknown } = {};
    return {
      state,
      code(c: number) {
        state.code = c;
        return this;
      },
      async send(body: unknown) {
        state.body = body;
      },
    };
  }

  function fakeRequest(token: string | null) {
    return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      socket: { remoteAddress: "127.0.0.1", remotePort: 55555 },
    };
  }

  async function pairUnpinned(id: string): Promise<string> {
    const offer = await createPairingOffer(pool, {
      allowLaunch: true,
      requireTailnet: false,
    });
    const result = await claimPairing(
      pool,
      { code: offer.code, claimer: claimer(id), callerAddr: null },
      "acceptor"
    );
    if (!result.ok) throw new Error("pairing failed in test setup");
    return result.token;
  }

  it("accepts a live unpinned credential and attaches peer identity", async () => {
    const token = await pairUnpinned("inst_auth1");
    const request = fakeRequest(token);
    const reply = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requirePeerAuth(pool, request as any, reply as any);
    expect(reply.state.code).toBeUndefined();
    expect(
      (request as { peerAuth?: { peerId: string; allowLaunch: boolean } })
        .peerAuth
    ).toMatchObject({ peerId: "inst_auth1", allowLaunch: true });
  });

  it("rejects a missing or unknown token", async () => {
    const none = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requirePeerAuth(pool, fakeRequest(null) as any, none as any);
    expect(none.state.code).toBe(401);

    const bad = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requirePeerAuth(pool, fakeRequest("nope") as any, bad as any);
    expect(bad.state.code).toBe(401);
  });

  it("rejects a token whose peer was revoked", async () => {
    const token = await pairUnpinned("inst_auth2");
    expect(await revokePeer(pool, "inst_auth2")).toBe(true);
    const reply = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requirePeerAuth(pool, fakeRequest(token) as any, reply as any);
    expect(reply.state.code).toBe(401);
  });

  it("hard-denies a pinned credential when whois cannot identify the caller", async () => {
    const token = await pairUnpinned("inst_auth3");
    await pool.query(
      `UPDATE peer_credentials SET tailnet_stable_id = 'nPINNED'
        WHERE peer_id = 'inst_auth3' AND revoked_at IS NULL`
    );
    const reply = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requirePeerAuth(pool, fakeRequest(token) as any, reply as any);
    expect(reply.state.code).toBe(403);
  });
});
