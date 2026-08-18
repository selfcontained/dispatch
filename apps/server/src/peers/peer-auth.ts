import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { tailscaleWhois } from "./tailscale.js";

export type PeerAuth = {
  peerId: string;
  credentialId: string;
  allowLaunch: boolean;
  allowMessage: boolean;
  allowFullAccess: boolean;
  allowEvents: boolean;
};

/**
 * A node's StableID cannot change between two requests from the same address,
 * but resolving it costs a `tailscale whois` subprocess with a 10s timeout —
 * once per authenticated request, on routes rate-limited at 120/min. Cache the
 * positive answers briefly.
 *
 * Negative results are deliberately NOT cached: an unidentifiable caller is a
 * hard deny, and caching that would let a transient tailscaled hiccup lock out
 * a legitimate peer for the whole TTL.
 */
const WHOIS_TTL_MS = 30_000;
const WHOIS_CACHE_MAX = 256;
const whoisCache = new Map<string, { stableId: string; expiresAt: number }>();

async function cachedWhoisStableId(addr: string): Promise<string | null> {
  const hit = whoisCache.get(addr);
  if (hit && hit.expiresAt > Date.now()) return hit.stableId;
  if (hit) whoisCache.delete(addr);

  const whois = await tailscaleWhois(addr);
  if (!whois) return null;

  // Cheap bound: the map is insertion-ordered, so the first key is the oldest.
  if (whoisCache.size >= WHOIS_CACHE_MAX) {
    const oldest = whoisCache.keys().next().value;
    if (oldest !== undefined) whoisCache.delete(oldest);
  }
  whoisCache.set(addr, {
    stableId: whois.stableId,
    expiresAt: Date.now() + WHOIS_TTL_MS,
  });
  return whois.stableId;
}

/** Test-only: forget cached whois answers. */
export function resetPeerWhoisCache(): void {
  whoisCache.clear();
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route authenticates with its own peer bearer token in a preHandler. */
    peerBearer?: boolean;
  }

  interface FastifyRequest {
    peerAuth?: PeerAuth;
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticates a calling peer instance: bearer lookup first, then — when the
 * credential was pinned at pair time — a live `tailscale whois` on the caller
 * socket that must return the same StableID. A pinned credential presented
 * from an unidentifiable or different node is a hard deny; identity headers
 * are never consulted.
 */
export async function requirePeerAuth(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "Peer authentication required." });
    return;
  }

  // One query does the credential lookup AND the fail-closed password check:
  // first-run open mode must never extend to peers, even ones holding a valid
  // token, so a cleared password denies here rather than falling through.
  const result = await pool.query<{
    id: string;
    peer_id: string;
    tailnet_stable_id: string | null;
    allow_launch: boolean;
    allow_message: boolean;
    allow_full_access: boolean;
    allow_events: boolean;
    password_set: boolean;
  }>(
    `SELECT c.id, c.peer_id, c.tailnet_stable_id,
            c.allow_launch, c.allow_message, c.allow_full_access, c.allow_events,
            EXISTS (
              SELECT 1 FROM settings WHERE key = 'password_hash' AND value <> ''
            ) AS password_set
       FROM peer_credentials c
       JOIN peers p ON p.id = c.peer_id AND p.revoked_at IS NULL
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
    [sha256(token)]
  );
  const row = result.rows[0];
  if (!row) {
    await reply.code(401).send({ error: "Invalid or revoked peer token." });
    return;
  }
  if (!row.password_set) {
    await reply.code(403).send({
      error: "This instance has no password set — peer access is disabled.",
    });
    return;
  }

  if (row.tailnet_stable_id) {
    const remote = request.socket.remoteAddress;
    const port = request.socket.remotePort;
    const stableId = remote
      ? await cachedWhoisStableId(`${stripMapped(remote)}:${port ?? 0}`)
      : null;
    if (!stableId || stableId !== row.tailnet_stable_id) {
      await reply
        .code(403)
        .send({ error: "Caller does not match the paired tailnet node." });
      return;
    }
  }

  // Last-seen timestamps are telemetry, not correctness — nothing reads them to
  // make a decision. Writing them per request costs two row writes on the
  // hottest peer path, so only refresh once a minute.
  void pool
    .query(
      `UPDATE peer_credentials SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id]
    )
    .catch(() => undefined);
  void pool
    .query(
      `UPDATE peers SET last_seen_at = now()
        WHERE id = $1
          AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
      [row.peer_id]
    )
    .catch(() => undefined);

  request.peerAuth = {
    peerId: row.peer_id,
    credentialId: row.id,
    allowLaunch: row.allow_launch,
    allowMessage: row.allow_message,
    allowFullAccess: row.allow_full_access,
    allowEvents: row.allow_events,
  };
}

/** Node reports IPv4 callers as ::ffff:a.b.c.d on dual-stack sockets. */
function stripMapped(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
