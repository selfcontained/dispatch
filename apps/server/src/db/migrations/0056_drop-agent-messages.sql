-- Agent-to-agent messages are blocks now (docs/design/blocks.md, step 2):
-- a post with `to` lands in the shared stream and is delivered as a prompt.
-- The separate table, its tab and its tool are gone. Hard cutover: rows are
-- not migrated.

DROP TABLE IF EXISTS agent_messages;
