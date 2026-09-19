-- Repair the `kind` CHECK on any install whose agent_stream_events table was
-- created by an earlier prerelease of this branch. That lineage created the
-- table under the file name this branch also ships, so node-pg-migrate (which
-- compares names, not content) skips the shipped file and its constraint
-- replacement never runs; the table is then left allowing every kind except
-- 'plan', and every ACP plan update fails a check violation that the event
-- handler swallows. Deleting the prerelease bookkeeping cannot repair it,
-- because a boot on v0.38.13-harness.2 already deletes those records before
-- the runner reads the table and so erases the only evidence of the lineage.
-- This file runs regardless. Replacing an identical constraint on an install
-- that never saw a prerelease is a scan and no change.
ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events
  ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan'));
