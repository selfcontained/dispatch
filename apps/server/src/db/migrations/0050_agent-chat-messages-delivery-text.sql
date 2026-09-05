-- A launch post shows the prompt as the launcher wrote it, but a dsh agent's
-- first turn is read from that post (it takes no launch argument). When the
-- turn must carry more than the display text (an MCP launch header, a
-- rendered template), the text to deliver is stored alongside.
ALTER TABLE agent_chat_messages ADD COLUMN IF NOT EXISTS delivery_text TEXT;
