-- When the user last read an agent's chat feed.
--
-- Unread was counted purely over `agent_chat_messages`, which works for a
-- CLI agent whose replies are chat rows. A Dispatch Harness agent's answers
-- are turns assembled from `agent_stream_events` and never chat rows, and
-- its persona is told not to repeat a reply through dispatch_chat_post, so
-- the badge could only ever fire for a question it asked. Counting turns
-- needs a per-agent watermark, because turns carry no per-row read state the
-- way chat messages do.
--
-- Existing agents are stamped with now() so a backlog of settled turns does
-- not light up every badge on the first load after the update, and new rows
-- default the same way: an agent is "read" as of the moment it exists, and
-- anything that settles after that is news.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS chat_read_at TIMESTAMPTZ;
UPDATE agents SET chat_read_at = NOW() WHERE chat_read_at IS NULL;
ALTER TABLE agents ALTER COLUMN chat_read_at SET DEFAULT NOW();
