CREATE TABLE task_attachments (
  id serial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  display_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_task_id_idx ON task_attachments(task_id);
