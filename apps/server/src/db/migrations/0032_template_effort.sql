ALTER TABLE templates ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
ALTER TABLE jobs ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
