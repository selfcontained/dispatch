-- Add auto_review flag for Autonomous Review feature.
-- When true, the agent will launch persona reviews and address feedback
-- before marking its task as complete.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_review BOOLEAN NOT NULL DEFAULT false;
