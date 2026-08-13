import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { getSetting } from "../db/settings.js";
import { tailscaleWhois } from "./tailscale.js";

export type PeerAuth = {
  peerId: string;
  credentialId: string;
  allowLaunch: boolean;
};

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
  // Fail closed if the password was cleared after pairing: first-run open
  // mode must never extend to peers, even ones holding a valid token.
  if ((await getSetting(pool, "password_hash")) === null) {
    await reply
      .code(403)
      .send({
        error: "This instance has no password set — peer access is disabled.",
      });
    return;
  }

  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "Peer authentication required." });
    return;
  }

  const result = await pool.query<{
    id: string;
    peer_id: string;
    tailnet_stable_id: string | null;
    allow_launch: boolean;
  }>(
    `SELECT c.id, c.peer_id, c.tailnet_stable_id, c.allow_launch
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

  if (row.tailnet_stable_id) {
    const remote = request.socket.remoteAddress;
    const port = request.socket.remotePort;
    const whois = remote
      ? await tailscaleWhois(`${stripMapped(remote)}:${port ?? 0}`)
      : null;
    if (!whois || whois.stableId !== row.tailnet_stable_id) {
      await reply
        .code(403)
        .send({ error: "Caller does not match the paired tailnet node." });
      return;
    }
  }

  await pool.query(
    `UPDATE peer_credentials SET last_used_at = now() WHERE id = $1`,
    [row.id]
  );
  await pool.query(`UPDATE peers SET last_seen_at = now() WHERE id = $1`, [
    row.peer_id,
  ]);
  request.peerAuth = {
    peerId: row.peer_id,
    credentialId: row.id,
    allowLaunch: row.allow_launch,
  };
}

/** Node reports IPv4 callers as ::ffff:a.b.c.d on dual-stack sockets. */
function stripMapped(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
