-- Launch context in the Chat feed: when an agent is created with an initial
-- prompt, startup files, links, or pins, that context is recorded as one user
-- post so the feed opens with it instead of hiding it in the console.
--
-- `origin` marks such a post ('launch'); ordinary posts leave it NULL.
-- `launched_by_agent_id` names the launching agent when another agent
-- created this one (dispatch_launch_agent), so the web can attribute the
-- post to it instead of to "You". NULL for launches from the UI or a job.
ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('launch'));
ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS launched_by_agent_id text;
