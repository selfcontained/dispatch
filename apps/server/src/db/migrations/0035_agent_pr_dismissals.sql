CREATE TABLE agent_pr_dismissals (
  agent_id text NOT NULL,
  url text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, url)
);
