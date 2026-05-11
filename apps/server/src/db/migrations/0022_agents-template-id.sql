-- Track which template (if any) an agent was launched from.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
