import crypto from "node:crypto";
import dns from "node:dns/promises";

import type { Pool } from "pg";

import { tokensEqual } from "../auth.js";
import { getOrCreateInstanceId } from "./identity.js";
import { getTailscaleSelf, tailscaleWhois } from "./tailscale.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Version of the cross-instance wire contract (pairing, launch, messages,
 * events). Negotiated once at pairing time: a mismatch fails the handshake
 * with a clear error instead of failing ambiguously on a later payload.
 * Bump on any incompatible change to the peer routes.
 */
export const PEER_PROTOCOL_VERSION = 1;

export type PeerRecord = {
  id: string;
  name: string;
  url: string;
  tailnetStableId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  allowLaunch: boolean;
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pairingCode(): string {
  // Six digits reads like every other device-pairing code. Single-use offers,
  // a 10-minute TTL, and strict rate limiting on the claim route carry the
  // brute-force load; the tailnet whois pin carries identity.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function cleanupExpiredPairings(pool: Pool): Promise<void> {
  await pool.query(
    "DELETE FROM peer_pairings WHERE expires_at <= now() AND claimed_at IS NULL"
  );
}

/** Acceptor side: create an offer whose code is displayed in THIS instance's UI. */
export async function createPairingOffer(
  pool: Pool,
  input: { allowLaunch: boolean; requireTailnet: boolean }
): Promise<{ pairingId: string; code: string; expiresAt: string }> {
  await cleanupExpiredPairings(pool);
  const pairingId = crypto.randomUUID();
  const code = pairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await pool.query(
    `INSERT INTO peer_pairings (id, code_hash, allow_launch, require_tailnet, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      pairingId,
      sha256(code),
      input.allowLaunch,
      input.requireTailnet,
      expiresAt,
    ]
  );
  return { pairingId, code, expiresAt: expiresAt.toISOString() };
}

export type ClaimInput = {
  code: string;
  claimer: {
    instanceId: string;
    name: string;
    /** Base URL the acceptor should dial to reach the claimer. */
    url: string;
    /** Bearer the acceptor will present when calling the claimer. */
    token: string;
  };
  /** Source address of the claim call, "ip:port", for whois pinning. */
  callerAddr: string | null;
};

export type ClaimResult =
  | { ok: true; instanceId: string; name: string; token: string }
  | { ok: false; status: number; error: string };

/**
 * Acceptor side: validate a claim against open offers, pin the caller's
 * tailnet identity, and issue the reverse credential. Registers the claimer
 * as a peer in the same stroke — pairing is the permission.
 */
export async function claimPairing(
  pool: Pool,
  input: ClaimInput,
  instanceName: string
): Promise<ClaimResult> {
  const offers = await pool.query<{
    id: string;
    code_hash: string;
    allow_launch: boolean;
    require_tailnet: boolean;
  }>(
    `SELECT id, code_hash, allow_launch, require_tailnet
       FROM peer_pairings
      WHERE expires_at > now() AND claimed_at IS NULL`
  );
  const offer = offers.rows.find((row) =>
    tokensEqual(row.code_hash, sha256(input.code))
  );
  if (!offer) {
    return { ok: false, status: 401, error: "Invalid or expired code." };
  }

  let callerStableId: string | null = null;
  if (input.callerAddr) {
    const whois = await tailscaleWhois(input.callerAddr);
    callerStableId = whois?.stableId ?? null;
  }
  if (offer.require_tailnet && !callerStableId) {
    // Absent tailnet identity is a hard deny, never a fallback.
    return {
      ok: false,
      status: 403,
      error: "Caller is not an identifiable tailnet node.",
    };
  }

  const inboundToken = randomToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `UPDATE peer_pairings SET claimed_at = now()
        WHERE id = $1 AND claimed_at IS NULL`,
      [offer.id]
    );
    if (claimed.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "Code was already used." };
    }
    await client.query(
      `INSERT INTO peers (id, name, url, tailnet_stable_id, outbound_token, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET name = $2, url = $3, tailnet_stable_id = $4,
             outbound_token = $5, last_seen_at = now(), revoked_at = NULL`,
      [
        input.claimer.instanceId,
        input.claimer.name,
        input.claimer.url,
        callerStableId,
        input.claimer.token,
      ]
    );
    // Re-pairing replaces the credential — never leave two live tokens per peer.
    await client.query(
      `UPDATE peer_credentials SET revoked_at = now()
        WHERE peer_id = $1 AND revoked_at IS NULL`,
      [input.claimer.instanceId]
    );
    await client.query(
      `INSERT INTO peer_credentials (id, peer_id, token_hash, tailnet_stable_id, allow_launch)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        input.claimer.instanceId,
        sha256(inboundToken),
        callerStableId,
        offer.allow_launch,
      ]
    );
    await client.query(`UPDATE peer_pairings SET peer_id = $2 WHERE id = $1`, [
      offer.id,
      input.claimer.instanceId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const instanceId = await getOrCreateInstanceId(pool);
  return { ok: true, instanceId, name: instanceName, token: inboundToken };
}

export type LinkInput = {
  /** Address of the accepting instance, e.g. cloud-vm.tailnet.ts.net:6767 */
  address: string;
  code: string;
  /** Whether the linked peer may launch agents HERE (the reverse policy). */
  allowLaunch: boolean;
  /** Override for how the peer dials us back (needed off-tailnet). */
  selfUrl?: string;
};

export type LinkResult =
  | { ok: true; peer: { id: string; name: string; url: string } }
  | { ok: false; status: number; error: string };

function normalizePeerUrl(address: string): string {
  const withScheme = /^https?:\/\//.test(address)
    ? address
    : `http://${address}`;
  return withScheme.replace(/\/+$/, "");
}

/** Best-effort whois of the instance we are dialing, to pin its node identity. */
async function whoisOfUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    const { address } = await dns.lookup(parsed.hostname);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const whois = await tailscaleWhois(`${address}:${port}`);
    return whois?.stableId ?? null;
  } catch {
    return null;
  }
}

/**
 * Claimer side: dial the accepting instance with the code the user typed,
 * hand it a freshly minted reverse credential, and store both directions.
 */
export async function linkToPeer(
  pool: Pool,
  input: LinkInput,
  deps: {
    instanceName: string;
    port: number;
    fetchImpl?: typeof fetch;
  }
): Promise<LinkResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const peerUrl = normalizePeerUrl(input.address);

  let selfUrl = input.selfUrl ?? null;
  if (!selfUrl) {
    const self = await getTailscaleSelf();
    if (!self?.dnsName) {
      return {
        ok: false,
        status: 409,
        error:
          "Cannot determine this instance's tailnet address. Provide selfUrl or start tailscale.",
      };
    }
    selfUrl = `http://${self.dnsName}:${deps.port}`;
  }

  const instanceId = await getOrCreateInstanceId(pool);
  const reverseToken = randomToken();

  let response: Response;
  try {
    response = await doFetch(`${peerUrl}/api/v1/auth/peers/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PEER_PROTOCOL_VERSION,
        code: input.code,
        instance: {
          id: instanceId,
          name: deps.instanceName,
          url: selfUrl,
          token: reverseToken,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: `Could not reach ${peerUrl}. Are both machines on the tailnet?`,
    };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      ok: false,
      status: response.status,
      error: body?.error ?? `Pairing failed (${response.status}).`,
    };
  }
  const body = (await response.json()) as {
    instanceId?: string;
    name?: string;
    token?: string;
    protocolVersion?: number;
  };
  if (!body.instanceId || !body.token) {
    return { ok: false, status: 502, error: "Peer sent a malformed response." };
  }
  if (body.protocolVersion !== PEER_PROTOCOL_VERSION) {
    return {
      ok: false,
      status: 409,
      error: `Peer speaks protocol v${body.protocolVersion ?? "unknown"}, this instance v${PEER_PROTOCOL_VERSION} — update the older instance and pair again.`,
    };
  }

  const peerStableId = await whoisOfUrl(peerUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO peers (id, name, url, tailnet_stable_id, outbound_token, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET name = $2, url = $3, tailnet_stable_id = $4,
             outbound_token = $5, last_seen_at = now(), revoked_at = NULL`,
      [
        body.instanceId,
        body.name ?? new URL(peerUrl).hostname,
        peerUrl,
        peerStableId,
        body.token,
      ]
    );
    await client.query(
      `UPDATE peer_credentials SET revoked_at = now()
        WHERE peer_id = $1 AND revoked_at IS NULL`,
      [body.instanceId]
    );
    await client.query(
      `INSERT INTO peer_credentials (id, peer_id, token_hash, tailnet_stable_id, allow_launch)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        body.instanceId,
        sha256(reverseToken),
        peerStableId,
        input.allowLaunch,
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    ok: true,
    peer: {
      id: body.instanceId,
      name: body.name ?? new URL(peerUrl).hostname,
      url: peerUrl,
    },
  };
}

export async function listPeers(pool: Pool): Promise<PeerRecord[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    url: string;
    tailnet_stable_id: string | null;
    created_at: Date;
    last_seen_at: Date | null;
    allow_launch: boolean | null;
  }>(
    `SELECT p.id, p.name, p.url, p.tailnet_stable_id, p.created_at, p.last_seen_at,
            c.allow_launch
       FROM peers p
       LEFT JOIN LATERAL (
         SELECT allow_launch FROM peer_credentials
          WHERE peer_id = p.id AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) c ON true
      WHERE p.revoked_at IS NULL
      ORDER BY p.created_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    tailnetStableId: row.tailnet_stable_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    allowLaunch: row.allow_launch ?? false,
  }));
}

/** Revoke a peer locally: kill their inbound credentials and our outbound use. */
export async function revokePeer(pool: Pool, peerId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE peers SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [peerId]
  );
  if (result.rowCount === 0) return false;
  await pool.query(
    `UPDATE peer_credentials SET revoked_at = now()
      WHERE peer_id = $1 AND revoked_at IS NULL`,
    [peerId]
  );
  return true;
}
