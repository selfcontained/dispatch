-- Independent durable subscriptions; no per-task backfill for board watches.
ALTER TABLE task_watches ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
CREATE TABLE task_board_watches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, agent_id)
);
CREATE INDEX task_board_watches_agent_idx ON task_board_watches(agent_id);

-- A source can have two coverage rows. Delivery deduplicates source identity,
-- while unsubscribe cascades only its own coverage. Row IDs protect acceptance
-- cleanup from deleting activity belonging to a later subscription generation.
ALTER TABLE task_watch_items DROP CONSTRAINT task_watch_items_task_id_agent_id_fkey;
ALTER TABLE task_watch_items DROP CONSTRAINT task_watch_items_pkey;
ALTER TABLE task_watch_items ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
ALTER TABLE task_watch_items ADD COLUMN watch_id bigint REFERENCES task_watches(id) ON DELETE CASCADE;
ALTER TABLE task_watch_items ADD COLUMN board_watch_id bigint REFERENCES task_board_watches(id) ON DELETE CASCADE;
UPDATE task_watch_items i SET watch_id = w.id FROM task_watches w
  WHERE i.task_id = w.task_id AND i.agent_id = w.agent_id;
ALTER TABLE task_watch_items ADD CONSTRAINT task_watch_items_coverage CHECK ((watch_id IS NULL) <> (board_watch_id IS NULL));
ALTER TABLE task_watch_items ADD CONSTRAINT task_watch_items_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE task_watch_items ADD CONSTRAINT task_watch_items_agent_fk FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX task_watch_items_explicit_idx ON task_watch_items (watch_id, source, item_id);
CREATE UNIQUE INDEX task_watch_items_board_idx ON task_watch_items (board_watch_id, source, item_id);
CREATE INDEX task_watch_items_delivery_idx ON task_watch_items (task_id, agent_id);

-- READ COMMITTED row locks serialize fanout with unsubscribe: fanout admitted
-- first is removed by the cascade; unsubscribe admitted first is skipped.
CREATE FUNCTION task_watch_enqueue(task text, source_kind text, source_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_watch_items (task_id, agent_id, source, item_id, watch_id)
    SELECT task_id, agent_id, source_kind, source_id, id
    FROM task_watches WHERE task_id = task FOR KEY SHARE
    ON CONFLICT DO NOTHING;
  INSERT INTO task_watch_items (task_id, agent_id, source, item_id, board_watch_id)
    SELECT task, w.agent_id, source_kind, source_id, w.id
    FROM task_board_watches w JOIN tasks t ON t.project_id = w.project_id
    WHERE t.id = task
      AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = task
        AND e.kind = 'agent_removed' AND e.data->>'agentId' = w.agent_id)
    FOR KEY SHARE OF w
    ON CONFLICT DO NOTHING;
END;
$$;
CREATE OR REPLACE FUNCTION task_watch_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM task_watch_enqueue(NEW.task_id, 'event', NEW.id::text);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION task_watch_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM task_watch_enqueue(NEW.stream_id, 'block', NEW.id::text);
  RETURN NEW;
END;
$$;
