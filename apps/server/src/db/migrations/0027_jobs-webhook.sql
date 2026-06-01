ALTER TABLE jobs
  ADD COLUMN webhook_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN webhook_secret  TEXT;

CREATE UNIQUE INDEX jobs_webhook_secret_unique
  ON jobs (webhook_secret)
  WHERE webhook_secret IS NOT NULL;
