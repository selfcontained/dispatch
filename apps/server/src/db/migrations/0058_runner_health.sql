ALTER TABLE runner_registrations
  ADD COLUMN health jsonb,
  ADD COLUMN health_received_at timestamptz;
