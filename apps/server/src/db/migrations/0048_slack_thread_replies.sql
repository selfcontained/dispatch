-- A Slack thread reply that became an ordinary Dispatch user post (not an
-- answer). This is the explicit provenance a later agent response is matched
-- against: the turn's stored prompt ids name `post_block_id`, nothing is
-- inferred from timing. One row per Slack message; one reply at most.
CREATE TABLE slack_thread_replies (
  -- Written just before the post itself (its id is derived from the Slack
  -- message), so a fast agent can't settle first. No FK for that reason:
  -- the sender rechecks that the post and the response still exist.
  post_block_id uuid PRIMARY KEY,
  binding_generation text NOT NULL,
  channel_id text NOT NULL,
  -- The Slack parent (a Dispatch-posted slack_messages row) and the person's message.
  thread_ts text NOT NULL,
  message_ts text NOT NULL,
  agent_id text NOT NULL,
  -- Set once a response is claimed for this message; never re-sent.
  response_block_id uuid,
  -- What to send ('reply' | 'error'), queued until Slack accepts it.
  outcome text CHECK (outcome IN ('reply', 'error')),
  -- The final reply text while queued; cleared once sent or given up.
  reply_text text,
  -- When the response was queued; the give-up window runs from here, not
  -- from the Slack message (turns can run for hours).
  queued_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  gave_up_at timestamptz,
  slack_reply_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_ts)
);
CREATE INDEX slack_thread_replies_due ON slack_thread_replies(next_attempt_at)
  WHERE response_block_id IS NOT NULL AND sent_at IS NULL AND gave_up_at IS NULL;
