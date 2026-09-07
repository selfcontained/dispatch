-- The Dispatch Harness agent type is `dispatch`. It shipped as `dsh`, the
-- name of the harness binary it drives, and every stored type value moves
-- with it: agents and their saved reviewer type, jobs, templates, the event
-- log, and the enabled-types setting (a JSON array held as text).
UPDATE agents SET type = 'dispatch' WHERE type = 'dsh';
UPDATE agents SET review_agent_type = 'dispatch' WHERE review_agent_type = 'dsh';
UPDATE jobs SET agent_type = 'dispatch' WHERE agent_type = 'dsh';
UPDATE templates SET agent_type = 'dispatch' WHERE agent_type = 'dsh';
UPDATE agent_events SET agent_type = 'dispatch' WHERE agent_type = 'dsh';
UPDATE settings
   SET value = replace(value, '"dsh"', '"dispatch"'), updated_at = NOW()
 WHERE key = 'enabled_agent_types' AND value LIKE '%"dsh"%';
