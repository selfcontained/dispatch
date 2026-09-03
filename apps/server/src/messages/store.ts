import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type StoredMessage = {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  /**
   * Whether the pane injection succeeded. `null` while the delivery is still
   * queued (possibly behind the quiet gate); a second `message.created`
   * event follows once it settles.
   */
  delivered: boolean | null;
  readAt: string | null;
  senderRepoRoot: string | null;
  recipientRepoRoot: string | null;
  createdAt: string;
};

export type InsertMessageInput = Omit<
  StoredMessage,
  "id" | "readAt" | "createdAt"
>;

type Row = {
  id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  sender_name: string;
  recipient_name: string;
  content: string;
  delivered: boolean | null;
  read_at: Date | null;
  sender_repo_root: string | null;
  recipient_repo_root: string | null;
  created_at: Date;
};

function toStoredMessage(row: Row): StoredMessage {
  return {
    id: row.id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    senderName: row.sender_name,
    recipientName: row.recipient_name,
    content: row.content,
    delivered: row.delivered,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    senderRepoRoot: row.sender_repo_root,
    recipientRepoRoot: row.recipient_repo_root,
    createdAt: row.created_at.toISOString(),
  };
}

export class MessageStore {
  constructor(private readonly pool: Pool) {}

  async insertMessage(input: InsertMessageInput): Promise<StoredMessage> {
    const result = await this.pool.query<Row>(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
          content, delivered, sender_repo_root, recipient_repo_root)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        randomUUID(),
        input.senderAgentId,
        input.recipientAgentId,
        input.senderName,
        input.recipientName,
        input.content,
        input.delivered,
        input.senderRepoRoot,
        input.recipientRepoRoot,
      ]
    );
    return toStoredMessage(result.rows[0]);
  }

  /** Record the outcome of a pending delivery. Returns the updated row. */
  async setDelivered(
    id: string,
    delivered: boolean
  ): Promise<StoredMessage | null> {
    const result = await this.pool.query<Row>(
      `UPDATE agent_messages SET delivered = $2 WHERE id = $1 RETURNING *`,
      [id, delivered]
    );
    return result.rows[0] ? toStoredMessage(result.rows[0]) : null;
  }

  /**
   * Startup recovery: the delivery queue is in-memory, so every row still
   * pending when the process starts was abandoned by the previous one. Mark
   * them not-delivered (no replay — a duplicate injection is worse than a
   * visible failure) and return the sender/recipient pairs touched so the
   * caller can announce them.
   */
  async sweepPendingDeliveries(): Promise<
    Array<{ senderAgentId: string; recipientAgentId: string }>
  > {
    const result = await this.pool.query<{
      sender_agent_id: string;
      recipient_agent_id: string;
    }>(
      `UPDATE agent_messages SET delivered = false
        WHERE delivered IS NULL
        RETURNING sender_agent_id, recipient_agent_id`
    );
    const seen = new Set<string>();
    const pairs: Array<{ senderAgentId: string; recipientAgentId: string }> =
      [];
    for (const row of result.rows) {
      const key = `${row.sender_agent_id}\u0000${row.recipient_agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        senderAgentId: row.sender_agent_id,
        recipientAgentId: row.recipient_agent_id,
      });
    }
    return pairs;
  }

  async listForAgent(agentId: string): Promise<StoredMessage[]> {
    // Bound the result set (mirrors the LIMIT 500 cap on the history-detail
    // query in activity.ts). Take the most recent 500, then return them in
    // ascending order for chronological rendering.
    const result = await this.pool.query<Row>(
      `SELECT * FROM (
         SELECT * FROM agent_messages
          WHERE sender_agent_id = $1 OR recipient_agent_id = $1
          ORDER BY created_at DESC
          LIMIT 500
       ) recent
       ORDER BY created_at ASC`,
      [agentId]
    );
    return result.rows.map(toStoredMessage);
  }

  async countUnreadForAgent(agentId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_messages
        WHERE recipient_agent_id = $1 AND read_at IS NULL`,
      [agentId]
    );
    return Number(result.rows[0].count);
  }

  async markReadForAgent(agentId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_messages SET read_at = now()
        WHERE recipient_agent_id = $1 AND read_at IS NULL`,
      [agentId]
    );
    return result.rowCount ?? 0;
  }
}
