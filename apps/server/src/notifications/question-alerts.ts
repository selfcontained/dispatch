import { SlackDeliveryUnknownError, SlackRetryError } from "./slack-app.js";
import type { Pool } from "pg";
import { OPEN_INPUT_SQL, FAILED_PARENT_INPUT_SQL } from "../chat/store.js";

type Alert = {
  block_id: string;
  binding_generation: string;
  agent_id: string;
  stream_id: string;
  thread_id: string | null;
  text: string;
  kind: string;
  data: unknown;
  name: string;
  attempts: number;
  /** Sent because an agent explicitly asked (notify with a form), not after the wait. */
  immediate: boolean;
};
const HUMAN_QUESTION_SQL = `(b.to_agent_id IS NULL OR ${FAILED_PARENT_INPUT_SQL})`;
const ALERT_SELECT = `n.block_id,n.binding_generation,n.attempts,n.immediate,b.author_agent_id AS agent_id,b.stream_id,b.thread_id,b.text,b.kind,b.data,a.name`;

/**
 * What became of an explicit send-now request.
 * - sent: Slack accepted the alert.
 * - retrying: not sent yet; the alert stays queued and the worker retries it.
 * - unknown: Slack's answer was unclear; it may have posted, so it is not resent.
 * - not_sent: it will not go out (answered, withdrawn, not human-directed, or
 *   the Slack connection changed).
 */
export type ImmediateAlertOutcome =
  | { delivery: "sent" }
  | { delivery: "retrying"; reason: string }
  | { delivery: "unknown"; reason: string }
  | { delivery: "not_sent"; reason: string };

type DeliverResult =
  | { sent: true }
  | { sent: false; error: unknown; stale: boolean };

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
        FROM blocks b WHERE b.created_at >= $2::timestamptz AND b.kind IN ('question','form') AND b.author_kind='agent' AND ${HUMAN_QUESTION_SQL}
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
      ) SELECT ${ALERT_SELECT}
        FROM claimed n JOIN blocks b ON b.id=n.block_id LEFT JOIN agents a ON a.id=b.author_agent_id`,
        [binding.generation]
      );
      const alert = claimed.rows[0];
      if (!alert) return;
      await this.deliver(alert);
    } finally {
      this.running = false;
    }
  }

  /**
   * Send one open, human-directed question/form's alert now (notify with a
   * form). It shares the worker's row, lease and retry state, so the two never
   * both send: whoever holds the lease sends, and a recorded success ends it.
   * A failure leaves the row queued for the worker's normal retry backoff.
   */
  async sendNow(blockId: string): Promise<ImmediateAlertOutcome> {
    const binding = await this.getBinding();
    if (!binding)
      return {
        delivery: "not_sent",
        reason: "The Slack app isn't connected.",
      };
    const claimed = await this.pool.query<Alert>(
      `WITH claimed AS (
        INSERT INTO question_notifications(block_id,binding_generation,due_at,next_attempt_at,attempts,lease_until,immediate)
        SELECT b.id,$2,now(),now(),1,now()+interval '60 seconds',true
        FROM blocks b WHERE b.id=$1 AND b.author_kind='agent' AND ${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL}
        ON CONFLICT (block_id) DO UPDATE SET binding_generation=EXCLUDED.binding_generation,
          due_at=now(),next_attempt_at=now(),attempts=question_notifications.attempts+1,
          lease_until=EXCLUDED.lease_until,immediate=true
        WHERE question_notifications.sent_at IS NULL AND question_notifications.cancelled_at IS NULL
          AND (question_notifications.lease_until IS NULL OR question_notifications.lease_until<now())
        RETURNING *
      ) SELECT ${ALERT_SELECT}
        FROM claimed n JOIN blocks b ON b.id=n.block_id LEFT JOIN agents a ON a.id=b.author_agent_id`,
      [blockId, binding.generation]
    );
    const alert = claimed.rows[0];
    if (!alert) return this.unclaimed(blockId);
    const result = await this.deliver(alert);
    if (result.sent) return { delivery: "sent" };
    if (result.stale)
      return {
        delivery: "not_sent",
        reason:
          "The form was answered, withdrawn or its Slack connection changed before it went out.",
      };
    if (result.error instanceof SlackDeliveryUnknownError)
      return {
        delivery: "unknown",
        reason:
          "Slack's response was unclear, so it may or may not have posted. Dispatch won't resend it, to avoid a duplicate; don't send it again.",
      };
    return {
      delivery: "retrying",
      reason:
        result.error instanceof SlackRetryError
          ? "Slack rate limited the alert. Dispatch will retry it automatically."
          : "Slack didn't accept the alert. Dispatch will retry it automatically.",
    };
  }

  /** Why a send-now request found nothing to claim. */
  private async unclaimed(blockId: string): Promise<ImmediateAlertOutcome> {
    const { rows } = await this.pool.query<{
      open: boolean;
      sent: boolean;
      leased: boolean;
    }>(
      `SELECT (${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL}) AS open,
        n.sent_at IS NOT NULL AS sent,
        COALESCE(n.lease_until>=now(),false) AS leased
       FROM blocks b LEFT JOIN question_notifications n ON n.block_id=b.id WHERE b.id=$1`,
      [blockId]
    );
    const row = rows[0];
    if (row?.sent) return { delivery: "sent" };
    if (row?.open && row.leased)
      return {
        delivery: "retrying",
        reason: "Dispatch is already sending this alert.",
      };
    return {
      delivery: "not_sent",
      reason: "The form is no longer open for a person to answer.",
    };
  }

  /** Transport for a claimed (leased) alert, then record the outcome on its row. */
  private async deliver(alert: Alert): Promise<DeliverResult> {
    // Recheck immediately before transport: cancellation can race the claim.
    const open = await this.pool.query(
      `SELECT 1 FROM blocks b WHERE b.id=$1 AND ${OPEN_INPUT_SQL} AND ${HUMAN_QUESTION_SQL}`,
      [alert.block_id]
    );
    if (!open.rowCount) {
      await this.pool.query(
        `UPDATE question_notifications SET lease_until=NULL WHERE block_id=$1`,
        [alert.block_id]
      );
      return { sent: false, error: null, stale: true };
    }
    let sent: boolean | { channelId: string; timestamp: string } = false;
    let error: unknown = null;
    let retrySeconds = Math.min(900, 15 * 2 ** Math.min(alert.attempts, 6));
    try {
      sent = await this.send(alert);
    } catch (caught) {
      error = caught;
      if (caught instanceof SlackRetryError)
        retrySeconds = Math.max(retrySeconds, caught.retryAfterMs / 1000);
    }
    // An explicit send whose outcome Slack left unclear may already be in the
    // channel: stop rather than risk a duplicate (the form stays in Dispatch).
    const stop = alert.immediate && error instanceof SlackDeliveryUnknownError;
    await this.pool.query(
      `UPDATE question_notifications SET lease_until=NULL,
        sent_at=CASE WHEN $2 THEN now() ELSE NULL END,
        cancelled_at=CASE WHEN $6 THEN now() ELSE cancelled_at END,
        next_attempt_at=now()+($3 * interval '1 second'),
        slack_channel_id=$4,slack_message_ts=$5 WHERE block_id=$1`,
      [
        alert.block_id,
        !!sent,
        retrySeconds,
        typeof sent === "object" ? sent.channelId : null,
        typeof sent === "object" ? sent.timestamp : null,
        stop,
      ]
    );
    if (sent) return { sent: true };
    // `false` without an error: the binding changed under the alert.
    return { sent: false, error, stale: error === null };
  }
}
