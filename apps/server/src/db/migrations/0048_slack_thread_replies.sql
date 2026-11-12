-- A Slack thread reply that became an ordinary Dispatch user post (not an
-- answer). This is the explicit provenance an agent's `notify({ replyTo })`
-- must name: only the agent the post went to may reply, only into this
-- thread, and only under the same Slack installation. Written just before
-- the post itself (its id is derived from the Slack message), so there is
-- no FK; senders recheck that the post still exists.
CREATE TABLE slack_thread_replies (
  post_block_id uuid PRIMARY KEY,
  binding_generation text NOT NULL,
  channel_id text NOT NULL,
  -- The Slack parent (a Dispatch-posted slack_messages row) and the person's message.
  thread_ts text NOT NULL,
  message_ts text NOT NULL,
  agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_ts)
);

-- Each explicit reply an agent sent into a thread. `sending_at` is written
-- before the Slack call; a row that never reached `sent_at` (crash, or an
-- outcome Slack left unclear) blocks an identical resend, so a reply is
-- posted at most once. A definite failure deletes the row so the agent may
-- retry.
CREATE TABLE slack_thread_reply_sends (
  id uuid PRIMARY KEY,
  post_block_id uuid NOT NULL,
  agent_id text NOT NULL,
  message_hash text NOT NULL,
  sending_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  slack_ts text
);
CREATE INDEX slack_thread_reply_sends_post ON slack_thread_reply_sends(post_block_id, message_hash);
