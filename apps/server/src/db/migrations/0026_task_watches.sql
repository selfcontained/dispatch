CREATE TABLE task_watches (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, agent_id)
);
CREATE INDEX task_watches_agent_idx ON task_watches(agent_id);

-- Each source insert and its per-watcher inbox entries commit atomically. A
-- transaction committing late cannot fall behind a timestamp delivery cursor.
CREATE TABLE task_watch_items (
  task_id text NOT NULL,
  agent_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('event', 'block')),
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, agent_id, source, item_id),
  FOREIGN KEY (task_id, agent_id) REFERENCES task_watches ON DELETE CASCADE
);

-- Lock watches before inserting inbox rows. At READ COMMITTED, a concurrent
-- watch deletion is waited out and then skipped, rather than failing the inbox
-- foreign-key check and aborting the source insert. This also covers cascades.
CREATE OR REPLACE FUNCTION task_watch_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_watch_items (task_id, agent_id, source, item_id)
    SELECT task_id, agent_id, 'event', NEW.id::text
    FROM task_watches WHERE task_id = NEW.task_id FOR KEY SHARE
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_watch_event_insert AFTER INSERT ON task_events
  FOR EACH ROW EXECUTE FUNCTION task_watch_event_insert();

CREATE OR REPLACE FUNCTION task_watch_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_watch_items (task_id, agent_id, source, item_id)
    SELECT task_id, agent_id, 'block', NEW.id::text
    FROM task_watches WHERE task_id = NEW.stream_id FOR KEY SHARE
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_watch_block_insert AFTER INSERT ON blocks
  FOR EACH ROW WHEN (NEW.stream_id LIKE 'tsk\_%')
  EXECUTE FUNCTION task_watch_block_insert();
