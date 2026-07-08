import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type StoredMessage = {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  delivered: boolean;
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
  delivered: boolean;
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
