-- Effort values belong to the engine's model catalog, not a fixed Dispatch enum.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_effort_check;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_effort_check;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_effort_check;
