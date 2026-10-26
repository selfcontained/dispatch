-- Source IDs deliberately have no FK: an immutable receipt survives source edits/deletion.
CREATE TABLE message_shares (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL,
  sharer_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  notification_id uuid NOT NULL UNIQUE REFERENCES blocks(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, sharer_id, recipient_id)
);
