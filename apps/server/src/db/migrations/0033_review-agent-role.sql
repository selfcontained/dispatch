-- Preserve the separately shipped role backfill in the migration chain.
-- Some existing installations have already recorded this migration name.
UPDATE agents
SET role = 'review'
WHERE role = 'standard'
  AND id IN (
    SELECT reviewer_agent_id
    FROM reviews
    WHERE reviewer_type = 'agent' AND reviewer_agent_id IS NOT NULL
    UNION
    SELECT agent_id
    FROM persona_reviews
  );
