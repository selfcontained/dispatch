-- Up Migration
ALTER TABLE blocks DROP CONSTRAINT blocks_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_kind_check
  CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review', 'finding', 'tasks', 'launch', 'task'));

-- Down Migration
-- Task cards have no legacy representation; preserve their caption and ID as text.
UPDATE blocks SET kind = 'text', text = concat_ws(E'\n\n', NULLIF(text, ''), 'Task ' || (data->>'taskId')), data = NULL, state = NULL WHERE kind = 'task';
ALTER TABLE blocks DROP CONSTRAINT blocks_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_kind_check
  CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review', 'finding', 'tasks', 'launch'));
