ALTER TABLE runner_registrations
  ADD COLUMN cleared_at timestamptz,
  ADD CONSTRAINT runner_registrations_clear_requires_revocation
    CHECK (cleared_at IS NULL OR revoked_at IS NOT NULL);
