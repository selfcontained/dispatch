-- CLI session tracking: stores the CLI session ID (e.g. Claude --session-id UUID)
-- so token harvesting can attribute sessions precisely and agents can resume
-- their CLI session across stop/restart cycles.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cli_session_id TEXT;
