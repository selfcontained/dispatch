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
export const PEER_PROTOCOL_VERSION = 2;

/**
 * What a pairing grants. Separable powers, because "may launch here" and "may
 * launch here with the sandbox off" are not the same permission, messaging an
 * agent is not launching one, and watching what agents here are doing is
 * neither.
 */
export type PeerCapabilities = {
  allowLaunch: boolean;
  allowMessage: boolean;
  allowFullAccess: boolean;
  allowEvents: boolean;
};

export const DEFAULT_CAPABILITIES: PeerCapabilities = {
  allowLaunch: true,
  allowMessage: true,
  allowFullAccess: false,
  allowEvents: true,
};

export type PeerRecord = {
  id: string;
  /** What THIS instance calls the peer — the label agents pass as `location`. */
  name: string;
  /** What the peer calls itself. Kept so the UI can show a rename happened. */
  reportedName: string | null;
  url: string;
  tailnetStableId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
} & PeerCapabilities;

/**
 * Local labels are what agents type as `location`, so they must be unique and
 * stable. Collisions get a numeric suffix rather than an error — pairing should
 * not fail because two machines are both called "macbook".
 */
async function uniqueLocalLabel(
  client: { query: Pool["query"] },
  desired: string,
  selfPeerId: string
): Promise<string> {
  const base = desired.trim().slice(0, 120) || "instance";
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const clash = await client.query(
      `SELECT 1 FROM peers
        WHERE lower(name) = lower($1) AND id <> $2 AND revoked_at IS NULL`,
      [candidate, selfPeerId]
    );
    if (clash.rowCount === 0) return candidate;
  }
  return `${base}-${selfPeerId.slice(-6)}`;
}

/**
 * Guards the peers row against an identity takeover. `instanceId` is asserted by
 * the caller and never proven, so an upsert keyed on it alone would let anyone
 * holding a valid pairing code repoint an EXISTING peer's url and token at
 * themselves. A live row pinned to a different tailnet node must be unlinked
 * deliberately, by a human, before its slot can be reused.
 */
async function assertNotSlotTakeover(
  client: { query: Pool["query"] },
  instanceId: string,
  callerStableId: string | null
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await client.query<{ tailnet_stable_id: string | null }>(
    `SELECT tailnet_stable_id FROM peers WHERE id = $1 AND revoked_at IS NULL`,
    [instanceId]
  );
  const row = existing.rows[0];
  if (!row) return { ok: true };
  if (row.tailnet_stable_id && row.tailnet_stable_id !== callerStableId) {
    return {
      ok: false,
      status: 409,
      error:
        "An instance with this id is already linked from a different machine. Unlink it here before pairing again.",
    };
  }
  return { ok: true };
}

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
  input: Partial<PeerCapabilities> & { requireTailnet: boolean }
): Promise<{ pairingId: string; code: string; expiresAt: string }> {
  await cleanupExpiredPairings(pool);
  // Defaulted here as well as at the route so a missing capability is never
  // written as NULL — the columns are NOT NULL, and a caller that omits one
  // means "the default", not "no policy".
  const caps = { ...DEFAULT_CAPABILITIES, ...input };
  const pairingId = crypto.randomUUID();
  const code = pairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await pool.query(
    `INSERT INTO peer_pairings
       (id, code_hash, allow_launch, allow_message, allow_full_access, allow_events, require_tailnet, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      pairingId,
      sha256(code),
      caps.allowLaunch,
      caps.allowMessage,
      caps.allowFullAccess,
      caps.allowEvents,
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
    allow_message: boolean;
    allow_full_access: boolean;
    allow_events: boolean;
    require_tailnet: boolean;
  }>(
    `SELECT id, code_hash, allow_launch, allow_message, allow_full_access,
            allow_events, require_tailnet
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
    const guard = await assertNotSlotTakeover(
      client,
      input.claimer.instanceId,
      callerStableId
    );
    if (!guard.ok) {
      await client.query("ROLLBACK");
      return guard;
    }
    // The local label is ours to choose and is preserved across re-pairs: a peer
    // renamed to "Cloud" here stays "Cloud" when it pairs again, even if its own
    // hostname changed. Only reported_name follows the remote.
    const label = await uniqueLocalLabel(
      client,
      input.claimer.name,
      input.claimer.instanceId
    );
    await client.query(
      `INSERT INTO peers (id, name, reported_name, url, tailnet_stable_id, outbound_token, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE
         SET reported_name = $3, url = $4, tailnet_stable_id = $5,
             outbound_token = $6, last_seen_at = now(), revoked_at = NULL`,
      [
        input.claimer.instanceId,
        label,
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
      `INSERT INTO peer_credentials
         (id, peer_id, token_hash, tailnet_stable_id, allow_launch, allow_message, allow_full_access, allow_events)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        input.claimer.instanceId,
        sha256(inboundToken),
        callerStableId,
        offer.allow_launch,
        offer.allow_message,
        offer.allow_full_access,
        offer.allow_events,
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

export type LinkInput = Partial<PeerCapabilities> & {
  /** Address of the accepting instance, e.g. cloud-vm.tailnet.ts.net:6767 */
  address: string;
  code: string;
  /** Local label for the peer, e.g. "Cloud". Defaults to what it calls itself. */
  name?: string;
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
  const caps = { ...DEFAULT_CAPABILITIES, ...input };

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
  const reportedName = body.name ?? new URL(peerUrl).hostname;
  // The user may name the peer at link time ("Cloud"); otherwise adopt what it
  // calls itself.
  const desiredLabel = input.name?.trim() || reportedName;
  let label = desiredLabel;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const guard = await assertNotSlotTakeover(
      client,
      body.instanceId,
      peerStableId
    );
    if (!guard.ok) {
      await client.query("ROLLBACK");
      return guard;
    }
    label = await uniqueLocalLabel(client, desiredLabel, body.instanceId);
    await client.query(
      `INSERT INTO peers (id, name, reported_name, url, tailnet_stable_id, outbound_token, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE
         SET reported_name = $3, url = $4, tailnet_stable_id = $5,
             outbound_token = $6, last_seen_at = now(), revoked_at = NULL`,
      [body.instanceId, label, reportedName, peerUrl, peerStableId, body.token]
    );
    await client.query(
      `UPDATE peer_credentials SET revoked_at = now()
        WHERE peer_id = $1 AND revoked_at IS NULL`,
      [body.instanceId]
    );
    await client.query(
      `INSERT INTO peer_credentials
         (id, peer_id, token_hash, tailnet_stable_id, allow_launch, allow_message, allow_full_access, allow_events)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        body.instanceId,
        sha256(reverseToken),
        peerStableId,
        caps.allowLaunch,
        caps.allowMessage,
        caps.allowFullAccess,
        caps.allowEvents,
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { ok: true, peer: { id: body.instanceId, name: label, url: peerUrl } };
}

/**
 * Rename a linked peer locally. Purely a local label — the remote instance is
 * never told, because "Cloud" is a statement about where it sits relative to
 * THIS machine, not about what it is.
 */
export async function renamePeer(
  pool: Pool,
  peerId: string,
  name: string
): Promise<
  { ok: true; name: string } | { ok: false; status: number; error: string }
> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "Name cannot be empty." };
  }
  const clash = await pool.query(
    `SELECT 1 FROM peers
      WHERE lower(name) = lower($1) AND id <> $2 AND revoked_at IS NULL`,
    [trimmed, peerId]
  );
  if (clash.rowCount && clash.rowCount > 0) {
    return {
      ok: false,
      status: 409,
      error: `Another linked instance is already called "${trimmed}".`,
    };
  }
  const updated = await pool.query(
    `UPDATE peers SET name = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [peerId, trimmed]
  );
  if (updated.rowCount === 0) {
    return { ok: false, status: 404, error: "Peer not found." };
  }
  return { ok: true, name: trimmed };
}

export async function listPeers(pool: Pool): Promise<PeerRecord[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    reported_name: string | null;
    url: string;
    tailnet_stable_id: string | null;
    created_at: Date;
    last_seen_at: Date | null;
    allow_launch: boolean | null;
    allow_message: boolean | null;
    allow_full_access: boolean | null;
    allow_events: boolean | null;
  }>(
    `SELECT p.id, p.name, p.reported_name, p.url, p.tailnet_stable_id,
            p.created_at, p.last_seen_at,
            c.allow_launch, c.allow_message, c.allow_full_access, c.allow_events
       FROM peers p
       LEFT JOIN LATERAL (
         SELECT allow_launch, allow_message, allow_full_access, allow_events
           FROM peer_credentials
          WHERE peer_id = p.id AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) c ON true
      WHERE p.revoked_at IS NULL
      ORDER BY p.created_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    reportedName: row.reported_name,
    url: row.url,
    tailnetStableId: row.tailnet_stable_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    allowLaunch: row.allow_launch ?? false,
    allowMessage: row.allow_message ?? false,
    allowFullAccess: row.allow_full_access ?? false,
    allowEvents: row.allow_events ?? false,
  }));
}

/**
 * Revoke a peer locally: kill their inbound credentials, stop our outbound use,
 * and retire the shadow rows they were driving. Without that last step the
 * shadows survive as agents nobody is mirroring — permanently frozen at
 * whatever status they held when the link died.
 */
export async function revokePeer(pool: Pool, peerId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE peers SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [peerId]
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE peer_credentials SET revoked_at = now()
        WHERE peer_id = $1 AND revoked_at IS NULL`,
      [peerId]
    );
    await client.query(
      `UPDATE agents
          SET status = 'stopped',
              latest_event_type = 'idle',
              latest_event_message = 'Linked instance was unlinked.',
              latest_event_updated_at = now(),
              updated_at = now()
        WHERE peer_id = $1 AND deleted_at IS NULL
          AND status IN ('creating', 'running', 'stopping')`,
      [peerId]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
