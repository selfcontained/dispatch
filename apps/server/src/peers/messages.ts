import crypto from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

const MAX_BACKOFF_MS = 15 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const DRAIN_INTERVAL_MS = 30 * 1000;
const RECEIPT_RETENTION_DAYS = 30;

export type PeerMessageBody = {
  targetAgentId: string;
  prompt: string;
  idempotencyKey: string;
};

type OutboxRow = {
  id: string;
  peer_id: string;
  path: string;
  body: PeerMessageBody;
  attempts: number;
};

type PeerDialInfo = { url: string; outbound_token: string };

async function loadPeerDialInfo(
  pool: Pool,
  peerId: string
): Promise<PeerDialInfo | null> {
  const result = await pool.query<PeerDialInfo>(
    `SELECT url, outbound_token FROM peers WHERE id = $1 AND revoked_at IS NULL`,
    [peerId]
  );
  return result.rows[0] ?? null;
}

async function postToPeer(
  peer: PeerDialInfo,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(`${peer.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${peer.outbound_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? `Peer responded ${response.status}.`);
  }
}

/**
 * Durable cross-instance message delivery. Every message is written to the
 * outbox BEFORE the first send attempt, so a crash mid-send retries instead
 * of losing content; the receiver dedupes on the idempotency key, so a retry
 * after an ambiguous failure never double-injects.
 */
export class PeerMessenger {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly deps: {
      pool: Pool;
      log: FastifyBaseLogger;
      fetchImpl?: typeof fetch;
    }
  ) {}

  /** Queue a prompt for an agent on a peer and try to deliver it now. */
  async sendPrompt(
    peerId: string,
    message: Omit<PeerMessageBody, "idempotencyKey">
  ): Promise<{ delivered: boolean }> {
    const idempotencyKey = crypto.randomUUID();
    const body: PeerMessageBody = { ...message, idempotencyKey };
    const outboxId = crypto.randomUUID();
    await this.deps.pool.query(
      `INSERT INTO peer_outbox (id, peer_id, path, body, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [outboxId, peerId, "/api/v1/peers/messages", body, idempotencyKey]
    );
    const delivered = await this.attempt({
      id: outboxId,
      peer_id: peerId,
      path: "/api/v1/peers/messages",
      body,
      attempts: 0,
    });
    return { delivered };
  }

  private async attempt(row: OutboxRow): Promise<boolean> {
    const peer = await loadPeerDialInfo(this.deps.pool, row.peer_id);
    if (!peer) {
      // Peer was revoked with mail still queued — drop it, there is no one to
      // deliver to and retrying forever would hold the queue open.
      await this.deps.pool.query(
        `UPDATE peer_outbox SET delivered_at = now(), last_error = 'peer revoked' WHERE id = $1`,
        [row.id]
      );
      return false;
    }
    try {
      await postToPeer(peer, row.path, row.body, this.deps.fetchImpl ?? fetch);
      await this.deps.pool.query(
        `UPDATE peer_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`,
        [row.id]
      );
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** Math.min(attempts, 20),
        MAX_BACKOFF_MS
      );
      await this.deps.pool.query(
        `UPDATE peer_outbox
            SET attempts = $2,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                last_error = $4
          WHERE id = $1`,
        [
          row.id,
          attempts,
          String(backoff),
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "send failed",
        ]
      );
      return false;
    }
  }

  /** Deliver every due message; called on a timer and after reconnects. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.deps.pool.query<OutboxRow>(
        `SELECT id, peer_id, path, body, attempts
           FROM peer_outbox
          WHERE delivered_at IS NULL AND next_attempt_at <= now()
          ORDER BY created_at
          LIMIT 100`
      );
      for (const row of due.rows) {
        await this.attempt(row);
      }
      await this.deps.pool.query(
        `DELETE FROM peer_outbox
          WHERE delivered_at IS NOT NULL
            AND delivered_at < now() - interval '7 days'`
      );
      await this.deps.pool.query(
        `DELETE FROM peer_message_receipts
          WHERE received_at < now() - interval '${RECEIPT_RETENTION_DAYS} days'`
      );
    } catch (error) {
      this.deps.log.warn({ err: error }, "Peer outbox drain failed");
    } finally {
      this.draining = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export type ReceiveResult =
  | { status: "delivered" | "duplicate" }
  | { status: "failed"; error: string };

/**
 * Receiver side: dedupe on (peer, idempotencyKey), then hand the prompt to
 * this instance's own injector — from the quiet gate onward, delivery is
 * byte-for-byte the local path.
 */
export async function receivePeerMessage(
  deps: {
    pool: Pool;
    injectAgentPrompt: (
      agentId: string,
      prompt: string,
      opts: { swallowFailure: boolean; awaitDelivery: boolean }
    ) => Promise<void>;
  },
  peerId: string,
  body: PeerMessageBody
): Promise<ReceiveResult> {
  const receipt = await deps.pool.query(
    `INSERT INTO peer_message_receipts (peer_id, idempotency_key)
     VALUES ($1, $2)
     ON CONFLICT (peer_id, idempotency_key) DO NOTHING
     RETURNING peer_id`,
    [peerId, body.idempotencyKey]
  );
  if (receipt.rowCount === 0) {
    // A retry of something we already accepted. Report success either way —
    // the first accept owns delivery, and re-injecting would duplicate it.
    return { status: "duplicate" };
  }
  try {
    await deps.injectAgentPrompt(body.targetAgentId, body.prompt, {
      swallowFailure: false,
      awaitDelivery: false,
    });
  } catch (error) {
    // Enqueue failed (agent gone / not running). Release the receipt so the
    // sender's retry is not swallowed as a duplicate.
    await deps.pool.query(
      `DELETE FROM peer_message_receipts WHERE peer_id = $1 AND idempotency_key = $2`,
      [peerId, body.idempotencyKey]
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Prompt delivery failed.",
    };
  }
  await deps.pool.query(
    `UPDATE peer_message_receipts SET delivered = true
      WHERE peer_id = $1 AND idempotency_key = $2`,
    [peerId, body.idempotencyKey]
  );
  return { status: "delivered" };
}
