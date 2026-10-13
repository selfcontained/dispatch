ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon_data bytea;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon_mime text;
