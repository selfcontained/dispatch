import type { Pool } from "pg";
import type { DriverEvent } from "../acp/driver.js";

type Receipt = { journalId: string; seq: number; event: DriverEvent };

/** The host cursor acknowledges storage; product projection can recover from this row. */
export class RemoteEventInbox {
  constructor(private readonly pool: Pool) {}

  async receive(agentId: string, receipt: Receipt): Promise<void> {
    const result = await this.pool.query(
      `UPDATE agents SET host_seq = $3, host_pending_event = $4::jsonb
       WHERE id = $1 AND host_journal_id = $2
         AND ((host_seq = $3::integer - 1 AND host_pending_event IS NULL)
           OR (host_seq = $3 AND host_pending_event = $4::jsonb))`,
      [agentId, receipt.journalId, receipt.seq, JSON.stringify(receipt.event)]
    );
    if (!result.rowCount)
      throw new Error("Remote journal cursor or session changed");
  }

  async projected(
    agentId: string,
    journalId: string,
    seq: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET host_pending_event = NULL
       WHERE id = $1 AND host_journal_id = $2 AND host_seq = $3`,
      [agentId, journalId, seq]
    );
  }

  async recover(
    agentId: string,
    project: (event: DriverEvent) => Promise<void>
  ): Promise<void> {
    const { rows } = await this.pool.query<Receipt>(
      `SELECT host_journal_id AS "journalId", host_seq AS seq, host_pending_event AS event
       FROM agents WHERE id = $1 AND host_pending_event IS NOT NULL`,
      [agentId]
    );
    const pending = rows[0];
    if (!pending) return;
    await project(pending.event);
    await this.projected(agentId, pending.journalId, pending.seq);
  }
}
