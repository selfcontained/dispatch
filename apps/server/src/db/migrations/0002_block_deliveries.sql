-- A post can be addressed to more than one agent: an @mention that names
-- several. One boolean could not say what happened to it — if a single
-- engine was dead the whole post read as undelivered, though the others
-- had it, and sending it again went to everybody.
--
-- Each recipient's own outcome, agent id to true/false/null. NULL on a
-- post with a single recipient, whose outcome `delivered` already carries.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS deliveries jsonb;
