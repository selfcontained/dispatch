-- Add description column missed during initial templates migration
ALTER TABLE templates ADD COLUMN IF NOT EXISTS description TEXT;
