-- Asking for a review is a request the person made, not a message they
-- typed: pressing Review used to write a post in their own voice made of
-- tool calls. It is its own kind of row now, so the stream can show who
-- asked and for what, and keep the instructions folded away.
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_origin_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_origin_check
  CHECK (origin IS NULL OR origin IN
    ('launch', 'turn', 'system_prompt', 'workspace', 'review_request'));
