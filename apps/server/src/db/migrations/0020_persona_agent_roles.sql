-- Before task personas, every agent with a persona was a reviewer.
-- Older launch paths did not consistently set the existing role column.
UPDATE agents SET role = 'review' WHERE persona IS NOT NULL;
