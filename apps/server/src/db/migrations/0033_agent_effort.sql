ALTER TABLE agents ADD COLUMN effort text CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
