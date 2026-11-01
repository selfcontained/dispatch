ALTER TABLE tasks ADD COLUMN launch_template_id text;

-- Deliberately no template foreign key: deleted choices remain visible as
-- unavailable instead of silently falling back to column automation.
