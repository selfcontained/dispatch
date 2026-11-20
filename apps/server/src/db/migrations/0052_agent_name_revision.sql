-- Protect automatic launch naming against explicit renames, including same-name edits.
ALTER TABLE agents ADD COLUMN name_revision integer NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN naming_requested boolean NOT NULL DEFAULT false;
