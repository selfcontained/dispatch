-- The steps a workspace goes through while an agent starts — worktree,
-- config, dependencies, engine — used to be status marks in the stream.
-- The stream is blocks only now, so they need a block of their own, and
-- an origin that says what it is.
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_origin_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_origin_check
  CHECK (origin IS NULL OR origin IN ('launch', 'turn', 'system_prompt', 'workspace'));
