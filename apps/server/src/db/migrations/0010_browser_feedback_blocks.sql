-- Deliberately no FK: a deleted queued block leaves a failed submission receipt.
ALTER TABLE browser_feedback_submissions ADD COLUMN block_id uuid;
