CREATE TABLE question_notifications (
  block_id uuid PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
  binding_generation text NOT NULL,
  due_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  slack_channel_id text,
  slack_message_ts text
);
CREATE INDEX question_notifications_due ON question_notifications(next_attempt_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;
