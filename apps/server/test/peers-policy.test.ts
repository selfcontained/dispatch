import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  describePeerLocations,
  handleIncomingPeerLaunch,
  listPeerLocations,
} from "../src/peers/launch.js";
import {
  claimPairing,
  createPairingOffer,
  listPeers,
  renamePeer,
} from "../src/peers/pairing.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

function claimer(id: string, name = `Peer ${id}`) {
  return {
    instanceId: id,
    name,
    url: `http://${id}.example:6767`,
    token: `reverse-token-${id}-${"x".repeat(24)}`,
  };
}

async function pair(
  id: string,
  caps: Partial<{
    allowLaunch: boolean;
    allowMessage: boolean;
    allowFullAccess: boolean;
  }>,
  name?: string
) {
  const offer = await createPairingOffer(pool, {
    ...caps,
    requireTailnet: false,
  });
  const result = await claimPairing(
    pool,
    { code: offer.code, claimer: claimer(id, name), callerAddr: null },
    "acceptor"
  );
  if (!result.ok) throw new Error(`pairing failed: ${result.error}`);
  return result;
}

describe("peer capabilities", () => {
  it("records each capability independently rather than deriving them from one flag", async () => {
    await pair("inst_caps", { allowLaunch: true, allowMessage: false });

    const peer = (await listPeers(pool)).find((p) => p.id === "inst_caps");
    expect(peer).toMatchObject({
      allowLaunch: true,
      allowMessage: false,
      // Never granted implicitly by allowLaunch — it disables the sandbox.
      allowFullAccess: false,
    });
  });

  it("defaults full access off even when everything else is granted", async () => {
    await pair("inst_default", { allowLaunch: true, allowMessage: true });
    const peer = (await listPeers(pool)).find((p) => p.id === "inst_default");
    expect(peer?.allowFullAccess).toBe(false);
  });
});

describe("peer slot takeover", () => {
  it("refuses a claim that reuses a live peer id from a different tailnet node", async () => {
    // First pairing pins the node.
    const offer1 = await createPairingOffer(pool, { requireTailnet: false });
    const first = await claimPairing(
      pool,
      {
        code: offer1.code,
        claimer: claimer("inst_pinned"),
        callerAddr: null,
      },
      "acceptor"
    );
    expect(first.ok).toBe(true);
    await pool.query(
      `UPDATE peers SET tailnet_stable_id = 'nodeAAA' WHERE id = 'inst_pinned'`
    );

    // A second claimer asserts the same instance id from elsewhere.
    const offer2 = await createPairingOffer(pool, { requireTailnet: false });
    const second = await claimPairing(
      pool,
      {
        code: offer2.code,
        claimer: {
          ...claimer("inst_pinned"),
          url: "http://attacker.example:6767",
          token: `attacker-token-${"z".repeat(24)}`,
        },
        callerAddr: null,
      },
      "acceptor"
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);

    // The original dial info survives untouched.
    const peer = (await listPeers(pool)).find((p) => p.id === "inst_pinned");
    expect(peer?.url).toBe("http://inst_pinned.example:6767");
  });
});

describe("local peer labels", () => {
  it("keeps labels unique so `location` is never ambiguous", async () => {
    await pair("inst_dup1", {}, "Cloud");
    await pair("inst_dup2", {}, "Cloud");

    const peers = await listPeers(pool);
    const names = [
      peers.find((p) => p.id === "inst_dup1")?.name,
      peers.find((p) => p.id === "inst_dup2")?.name,
    ];
    expect(names[0]).toBe("Cloud");
    expect(names[1]).toBe("Cloud-2");
  });

  it("renames locally and keeps what the peer calls itself", async () => {
    await pair("inst_rename", {}, "vm-847ab.internal");

    const renamed = await renamePeer(pool, "inst_rename", "Cloud Box");
    expect(renamed).toMatchObject({ ok: true, name: "Cloud Box" });

    const peer = (await listPeers(pool)).find((p) => p.id === "inst_rename");
    expect(peer?.name).toBe("Cloud Box");
    expect(peer?.reportedName).toBe("vm-847ab.internal");
  });

  it("refuses a rename that collides with another linked instance", async () => {
    await pair("inst_clash_a", {}, "Studio");
    await pair("inst_clash_b", {}, "Laptop");

    const result = await renamePeer(pool, "inst_clash_b", "studio");
    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});

describe("incoming launch policy", () => {
  const agentManager = {
    createAgent: async (input: { name: string }) => ({
      id: "agt_test",
      name: input.name,
      status: "creating",
    }),
  } as never;

  async function seedRepo(root: string) {
    await pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, codex_args, updated_at)
       VALUES ($1, 'seed', 'claude', 'standard', 'stopped', $2, '[]'::jsonb, NOW())`,
      [`agt_seed_${Math.random().toString(36).slice(2, 8)}`, root]
    );
  }

  it("rejects a cwd outside every advertised repo root", async () => {
    const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "peer-allowed-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "peer-outside-"));
    await seedRepo(allowed);

    await expect(
      handleIncomingPeerLaunch(
        { pool, agentManager },
        {
          name: "remote",
          prompt: "do a thing",
          type: "claude",
          cwd: outside,
          parentAddress: "inst_x:agt_y",
        },
        { allowFullAccess: true }
      )
    ).rejects.toThrow(/not inside a repository this instance shares/);
  });

  it("rejects a traversal that resolves outside an advertised root", async () => {
    const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "peer-trav-"));
    await seedRepo(allowed);

    await expect(
      handleIncomingPeerLaunch(
        { pool, agentManager },
        {
          name: "remote",
          prompt: "do a thing",
          type: "claude",
          cwd: path.join(allowed, "..", ".."),
          parentAddress: "inst_x:agt_y",
        },
        { allowFullAccess: true }
      )
    ).rejects.toThrow(/not inside a repository this instance shares/);
  });

  it("accepts a subdirectory of an advertised root", async () => {
    const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "peer-ok-"));
    const nested = path.join(allowed, "packages", "web");
    await fs.mkdir(nested, { recursive: true });
    await seedRepo(allowed);

    const result = await handleIncomingPeerLaunch(
      { pool, agentManager },
      {
        name: "remote",
        prompt: "do a thing",
        type: "claude",
        cwd: nested,
        parentAddress: "inst_x:agt_y",
      },
      { allowFullAccess: false }
    );
    expect(result.name).toBe("remote");
  });

  it("refuses full access when the pairing did not grant it", async () => {
    const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "peer-fa-"));
    await seedRepo(allowed);

    await expect(
      handleIncomingPeerLaunch(
        { pool, agentManager },
        {
          name: "remote",
          prompt: "do a thing",
          type: "claude",
          cwd: allowed,
          fullAccess: true,
          parentAddress: "inst_x:agt_y",
        },
        { allowFullAccess: false }
      )
    ).rejects.toThrow(/not allowed to launch full-access agents/);
  });
});

describe("peer locations for the launch tool description", () => {
  it("reports a recently-seen peer as reachable and a stale one as not", async () => {
    await pair("inst_live", { allowLaunch: true }, "LiveBox");
    await pair("inst_stale", { allowLaunch: false }, "StaleBox");

    await pool.query(
      `UPDATE peers SET last_seen_at = now() WHERE id = 'inst_live'`
    );
    await pool.query(
      `UPDATE peers SET last_seen_at = now() - interval '2 hours' WHERE id = 'inst_stale'`
    );

    const locations = await listPeerLocations(pool);
    const live = locations.find((l) => l.name === "LiveBox");
    const stale = locations.find((l) => l.name === "StaleBox");

    expect(live).toMatchObject({ reachable: true, canLaunch: true });
    expect(stale).toMatchObject({ reachable: false, canLaunch: false });

    // This string is what a model actually reads, so assert it directly.
    const described = describePeerLocations([live!, stale!]);
    expect(described).toContain('"LiveBox"');
    expect(described).toContain("not responding recently");
    expect(described).toContain("launching not permitted there");
  });

  it("tells the model to launch locally when nothing is linked", () => {
    expect(describePeerLocations([])).toContain("No instances are currently linked");
  });
});
