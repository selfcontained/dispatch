-- Surface schema v2: slotted documents. The header (status + progress strip)
-- and footer (document-level actions) live beside the block list. Existing
-- rows keep schema_version 1 and render as a legacy notice in the sidebar;
-- new writes stamp schema_version 2.
ALTER TABLE agent_surfaces ADD COLUMN IF NOT EXISTS header JSONB;
ALTER TABLE agent_surfaces ADD COLUMN IF NOT EXISTS footer JSONB;
