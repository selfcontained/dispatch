-- An explicit notify(form) sends its Slack alert at once instead of waiting
-- five minutes. Marked so a worker retry of that same alert does not label it
-- "unanswered for 5 minutes".
ALTER TABLE question_notifications ADD COLUMN immediate boolean NOT NULL DEFAULT false;
