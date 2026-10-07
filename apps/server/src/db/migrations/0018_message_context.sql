-- A bounded recipient-specific snapshot, reused on failed-delivery retries.
CREATE TABLE block_delivery_context (
  block_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  context text NOT NULL,
  PRIMARY KEY (block_id, agent_id)
);
