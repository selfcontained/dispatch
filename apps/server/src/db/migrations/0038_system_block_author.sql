ALTER TABLE blocks DROP CONSTRAINT blocks_author_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_author_kind_check CHECK (author_kind IN ('agent', 'user', 'system'));
