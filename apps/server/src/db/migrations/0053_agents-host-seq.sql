-- The last agent-host journal sequence the server folded into
-- agent_stream_events, per agent. The host replays its journal from this
-- point when the server reconnects (after a restart, a dropped socket), so
-- no event is applied twice and none is lost.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS host_seq INTEGER NOT NULL DEFAULT 0;
