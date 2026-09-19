-- Step 4 of docs/design/blocks.md: pins and surfaces are gone. Anything an
-- agent wants a person to read, copy or click is a block in the stream.
-- Hard cutover: rows are not migrated.

DROP TABLE IF EXISTS pin_events;
DROP TABLE IF EXISTS agent_surface_interactions;
DROP TABLE IF EXISTS agent_surfaces;
ALTER TABLE agents DROP COLUMN IF EXISTS pins;
