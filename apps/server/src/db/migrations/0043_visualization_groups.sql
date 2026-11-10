ALTER TABLE blocks DROP CONSTRAINT blocks_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_kind_check
  CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review', 'finding', 'tasks', 'launch', 'task', 'metric', 'chart', 'visualization_group'));
