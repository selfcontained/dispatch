-- Optional, ordered goals an agent manages on a task. Existing tasks start
-- with none. Retired goals stay as rows (and in activity) but leave the
-- progress denominator.
CREATE TABLE task_goals (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  position integer NOT NULL,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'completed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, position)
);

-- A retried goal write carrying the same requestId replays its stored result
-- instead of applying twice.
CREATE TABLE task_goal_requests (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, request_id)
);
