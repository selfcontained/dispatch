-- OpenCode V2 has no Dispatch-enforced restricted mode. Persist the supported
-- access mode for existing agents and saved launch configurations.
UPDATE agents SET full_access = TRUE WHERE type = 'opencode' AND NOT full_access;
UPDATE templates SET full_access = TRUE WHERE agent_type = 'opencode' AND NOT full_access;
UPDATE jobs SET full_access = TRUE WHERE agent_type = 'opencode' AND NOT full_access;
