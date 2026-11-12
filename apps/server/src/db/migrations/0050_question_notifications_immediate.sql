-- An explicit notify(form) sends its Slack alert at once instead of waiting
-- five minutes. Marked so a worker retry of that same alert does not label it
-- "unanswered for 5 minutes".
ALTER TABLE question_notifications ADD COLUMN immediate boolean NOT NULL DEFAULT false;
-- A form sent into a Slack thread (notify with replyTo, or asked during a
-- Slack follow-up turn) retries into that same thread, never the channel root.
ALTER TABLE question_notifications ADD COLUMN thread_ts text;
-- The Slack thread an ask was posted in (NULL: channel root). Answers to it
-- record their return path into this thread so notify({ replyTo }) works.
ALTER TABLE slack_messages ADD COLUMN thread_ts text;
