-- A task's conversation is its own stream (blocks with stream_id = the
-- task id), so the per-agent pointer into an agent's stream is gone.
ALTER TABLE task_agents DROP COLUMN IF EXISTS conversation;
