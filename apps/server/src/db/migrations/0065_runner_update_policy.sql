ALTER TABLE runner_registrations ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
