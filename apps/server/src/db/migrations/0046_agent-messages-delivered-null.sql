-- dispatch_send_message now records real delivery: a row is inserted with
-- delivered = NULL while the pane write is queued (possibly behind the quiet
-- gate) and settles to true/false once it completes. Rows still NULL at
-- startup were abandoned by the previous process and are swept to false.
ALTER TABLE agent_messages ALTER COLUMN delivered DROP NOT NULL;
ALTER TABLE agent_messages ALTER COLUMN delivered DROP DEFAULT;
