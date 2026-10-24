-- Tasks: a project-scoped board. A task sits in one of its project's
-- columns; a column may carry a trigger that launches a template when a
-- task enters it. Agents come and go on a task (builder, then reviewer),
-- so each assignment is its own row and the task keeps the current one.

CREATE TABLE IF NOT EXISTS task_columns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Stable slug within the project; agents name columns by it.
  key text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  -- TaskColumnTrigger (apps/server/src/tasks/types.ts) or NULL.
  trigger jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Deleting a column is refused while it holds tasks; RESTRICT backs that.
  column_id text NOT NULL REFERENCES task_columns(id) ON DELETE RESTRICT,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  position double precision NOT NULL,
  assigned_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  -- TaskLink[]
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent', 'system')),
  created_by_agent_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_by_kind <> 'agent' OR created_by_agent_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS tasks_project_column_idx
  ON tasks(project_id, column_id, position);
CREATE INDEX IF NOT EXISTS tasks_assigned_idx
  ON tasks(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;

-- Every agent that has been assigned to a task. The task's conversation
-- is its own stream (blocks with stream_id = the task id), so nothing
-- here points into an agent's stream.
CREATE TABLE IF NOT EXISTS task_agents (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('trigger', 'manual', 'self')),
  column_id text REFERENCES task_columns(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, agent_id)
);

CREATE INDEX IF NOT EXISTS task_agents_agent_idx ON task_agents(agent_id);

-- The task's activity log: moves, assignments, trigger outcomes, links.
CREATE TABLE IF NOT EXISTS task_events (
  id uuid PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system')),
  actor_agent_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_kind <> 'agent' OR actor_agent_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, created_at);
