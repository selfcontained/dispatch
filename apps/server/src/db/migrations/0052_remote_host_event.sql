-- Receiving a remote event and advancing its journal cursor are one row write.
-- At most one event per session is awaiting Dispatch projection.
ALTER TABLE agents ADD COLUMN host_pending_event jsonb;
