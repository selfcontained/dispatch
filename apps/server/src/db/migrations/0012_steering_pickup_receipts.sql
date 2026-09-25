-- Kept separately from delivery acceptance, per recipient and attempt.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS steering_receipts jsonb;
