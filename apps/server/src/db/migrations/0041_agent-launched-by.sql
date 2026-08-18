-- Records who launched an agent, independently of the delegation lineage.
--
-- `parent_agent_id` means "this agent is a child of that one" and drives the
-- sidebar's Sub Agents grouping. dispatch_launch_agent's `child: false` option
-- launches an agent that is deliberately *not* part of the launcher's lineage,
-- so it must leave parent_agent_id null — but the launcher is still the thing
-- that created the session, and losing that would leave independent launches
-- with no provenance and no owner allowed to archive them.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS launched_by_agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_launched_by_agent_id
  ON agents (launched_by_agent_id)
  WHERE launched_by_agent_id IS NOT NULL;

-- Every agent launched by another agent to date was launched as a child, so
-- the launcher is exactly the recorded parent.
UPDATE agents
SET launched_by_agent_id = parent_agent_id
WHERE parent_agent_id IS NOT NULL AND launched_by_agent_id IS NULL;
