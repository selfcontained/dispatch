import { SlackRetryError } from "./slack-app.js";
import type { Pool } from "pg";
import { OPEN_INPUT_SQL, FAILED_PARENT_INPUT_SQL } from "../chat/store.js";

type Alert = {
  block_id: string;
  binding_generation: string;
  agent_id: string;
  stream_id: string;
  thread_id: string | null;
  text: string;
  data: { options?: { label: string }[] } | null;
  name: string;
  attempts: number;
};
const HUMAN_QUESTION_SQL = `(b.to_agent_id IS NULL OR ${FAILED_PARENT_INPUT_SQL})`;

/** One successful alert per human-directed question. Read receipts/focus are deliberately absent. */
export class QuestionAlerts {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private pool: Pool,
    private send: (
      alert: Alert
    ) => Promise<boolean | { channelId: string; timestamp: string }>,
    private getBinding: () => Promise<{
      generation: string;
      enabledAt: string;
    } | null>
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 15000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  stop() {
    clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const binding = await this.getBinding();
      if (!binding) return;
      await this.pool.query(
        `INSERT INTO question_notifications(block_id,binding_generation,due_at,next_attempt_at)
        SELECT b.id,$1,b.created_at + interval '5 minutes',b.created_at + interval '5 minutes'
        FROM blocks b WHERE b.created_at >= $2::timestamptz AND b.kind='question' AND b.author_kind='agent' AND ${HUMAN_QUESTION_SQL}
        AND ${OPEN_INPUT_SQL} ON CONFLICT DO NOTHING`,
        [binding.generation, binding.enabledAt]
      );
      await this.pool
        .query(`UPDATE question_notifications n SET cancelled_at=now()
        FROM blocks b WHERE b.id=n.block_id AND NOT (${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL})
        AND n.sent_at IS NULL AND n.cancelled_at IS NULL`);
      const claimed = await this.pool.query<Alert>(
        `WITH candidate AS (
        SELECT n.block_id FROM question_notifications n JOIN blocks b ON b.id=n.block_id
        WHERE n.sent_at IS NULL AND n.cancelled_at IS NULL AND n.next_attempt_at<=now()
        AND n.binding_generation=$1 AND (n.lease_until IS NULL OR n.lease_until<now()) AND ${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL}
        ORDER BY n.next_attempt_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED
      ), claimed AS (
        UPDATE question_notifications n SET lease_until=now()+interval '60 seconds',attempts=attempts+1
        FROM candidate c WHERE c.block_id=n.block_id RETURNING n.*
      ) SELECT n.block_id,n.binding_generation,n.attempts,b.author_agent_id AS agent_id,b.stream_id,b.thread_id,b.text,b.data,a.name
        FROM claimed n JOIN blocks b ON b.id=n.block_id LEFT JOIN agents a ON a.id=b.author_agent_id`,
        [binding.generation]
      );
      const alert = claimed.rows[0];
      if (!alert) return;
      // Recheck immediately before transport: cancellation can race the claim.
      const open = await this.pool.query(
        `SELECT 1 FROM blocks b WHERE b.id=$1 AND ${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL}`,
        [alert.block_id]
      );
      if (!open.rowCount) return;
      let sent: boolean | { channelId: string; timestamp: string } = false;
      let retrySeconds = Math.min(900, 15 * 2 ** Math.min(alert.attempts, 6));
      try {
        sent = await this.send(alert);
      } catch (error) {
        if (error instanceof SlackRetryError)
          retrySeconds = Math.max(retrySeconds, error.retryAfterMs / 1000);
      }
      await this.pool.query(
        `UPDATE question_notifications SET lease_until=NULL,
        sent_at=CASE WHEN $2 THEN now() ELSE NULL END,
        next_attempt_at=now()+($3 * interval '1 second'),
        slack_channel_id=$4,slack_message_ts=$5 WHERE block_id=$1`,
        [
          alert.block_id,
          !!sent,
          retrySeconds,
          typeof sent === "object" ? sent.channelId : null,
          typeof sent === "object" ? sent.timestamp : null,
        ]
      );
    } finally {
      this.running = false;
    }
  }
}
