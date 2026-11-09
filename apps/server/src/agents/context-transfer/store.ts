import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  TransferConflict,
  TransferRequestSchema,
  type TransferRecord,
  type TransferRequest,
  type TransferState,
} from "./types.js";

type Row = {
  transfer_id: string;
  request: TransferRequest;
  request_hash: string;
  state: TransferState;
  revision: number;
  launch_key: string;
  successor_agent_id: string | null;
  failure_reason: string | null;
};
function record(row: Row): TransferRecord {
  return {
    transferId: row.transfer_id,
    request: TransferRequestSchema.parse(row.request),
    requestHash: row.request_hash,
    state: row.state,
    revision: row.revision,
    launchKey: row.launch_key,
    successorAgentId: row.successor_agent_id,
    failureReason: row.failure_reason,
  };
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export interface TransferLedger {
  prepare(input: TransferRequest): Promise<TransferRecord>;
  get(id: string): Promise<TransferRecord | null>;
  cancel(id: string): Promise<TransferRecord | null>;
  findBoundary(
    agentId: string,
    boundary: number
  ): Promise<TransferRecord | null>;
  compareAndSet(
    current: TransferRecord,
    next: {
      state: TransferState;
      successorAgentId?: string;
      failureReason?: string;
    }
  ): Promise<TransferRecord | null>;
}

/** Durable intent only. No agent construction, permissions or write lease. */
export class PgTransferLedger implements TransferLedger {
  constructor(private readonly pool: Pool) {}

  async prepare(input: TransferRequest): Promise<TransferRecord> {
    const request = TransferRequestSchema.parse(input);
    const requestHash = digest(JSON.stringify(request));
    const transferId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<Row>(
        `INSERT INTO context_transfers
          (transfer_id, predecessor_id, boundary, chain_id, workspace_key, request, request_hash, launch_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          transferId,
          request.budget.identity.agentId,
          request.budget.boundary,
          request.chainId,
          digest(request.budget.identity.cwd),
          JSON.stringify(request),
          requestHash,
          `context-transfer/${transferId}`,
        ]
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<Row>(
            `SELECT * FROM context_transfers WHERE predecessor_id = $1 AND boundary = $2`,
            [request.budget.identity.agentId, request.budget.boundary]
          )
        ).rows[0];
      if (!row || row.request_hash !== requestHash) {
        throw new TransferConflict(
          "Transfer boundary, chain or workspace already reserved"
        );
      }
      await client.query("COMMIT");
      return record(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<TransferRecord | null> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM context_transfers WHERE transfer_id = $1",
      [id]
    );
    return rows[0] ? record(rows[0]) : null;
  }

  async cancel(id: string): Promise<TransferRecord | null> {
    // Cancellation wins over any concurrent nonterminal receipt transition.
    const { rows } = await this.pool.query<Row>(
      `UPDATE context_transfers SET state = 'cancelled', revision = revision + 1, updated_at = now()
       WHERE transfer_id = $1 AND state NOT IN ('cancelled', 'failed') RETURNING *`,
      [id]
    );
    return rows[0] ? record(rows[0]) : this.get(id);
  }

  async findBoundary(
    agentId: string,
    boundary: number
  ): Promise<TransferRecord | null> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM context_transfers WHERE predecessor_id = $1 AND boundary = $2",
      [agentId, boundary]
    );
    return rows[0] ? record(rows[0]) : null;
  }

  async compareAndSet(
    current: TransferRecord,
    next: {
      state: TransferState;
      successorAgentId?: string;
      failureReason?: string;
    }
  ): Promise<TransferRecord | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE context_transfers SET state = $4, revision = revision + 1,
         successor_agent_id = COALESCE($5, successor_agent_id),
         failure_reason = COALESCE($6, failure_reason), updated_at = now()
       WHERE transfer_id = $1 AND revision = $2 AND state = $3 RETURNING *`,
      [
        current.transferId,
        current.revision,
        current.state,
        next.state,
        next.successorAgentId ?? null,
        next.failureReason ?? null,
      ]
    );
    return rows[0] ? record(rows[0]) : null;
  }
}
