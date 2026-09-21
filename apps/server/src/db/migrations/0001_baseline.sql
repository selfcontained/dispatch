-- Dispatch schema, one baseline. This version is a fresh install: nothing
-- migrates from earlier schemas, so the whole shape lives here and changes
-- append new files after it. Tables are grouped by subsystem.

-- ── Agents ───────────────────────────────────────────────────────────────

CREATE TABLE agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'codex',
  -- 'standard' or 'assisted_update' (the agent the release runtime drives).
  role text NOT NULL DEFAULT 'standard',
  status text NOT NULL,
  cwd text NOT NULL,
  files_dir text,
  agent_args jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  full_access boolean NOT NULL DEFAULT false,
  -- Workspace: an optional git worktree checked out for this agent.
  worktree_path text,
  worktree_branch text,
  base_branch text,
  git_context jsonb,
  git_context_stale boolean NOT NULL DEFAULT true,
  git_context_updated_at timestamptz,
  -- Lifecycle phases and errors.
  setup_phase text,
  archive_phase text,
  archive_cleanup_mode text,
  last_error text,
  -- The latest status event, denormalised for the sidebar.
  latest_event_type text,
  latest_event_message text,
  latest_event_metadata jsonb,
  latest_event_updated_at timestamptz,
  -- Lineage: the parent whose stream this agent posts into, and whoever ran
  -- launch_agent (set even for child: false launches).
  parent_agent_id text,
  launched_by_agent_id text,
  -- Personas are launch profiles; the briefing is kept for the record.
  persona text,
  persona_context text,
  review_agent_type text,
  auto_review boolean NOT NULL DEFAULT false,
  template_id text,
  -- The engine's own session id, so a restart resumes the conversation.
  cli_session_id text,
  -- Monotonic host launch counter; a stale host's events are dropped.
  host_seq integer NOT NULL DEFAULT 0,
  simulator_udid text,
  -- Archived agents keep their row until retention deletes it.
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agents_parent_idx ON agents (parent_agent_id)
  WHERE parent_agent_id IS NOT NULL;
CREATE INDEX agents_archived_idx ON agents (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Status events: what the agent was doing, when. No FK: rows outlive the
-- agent so activity history stays readable until retention removes them.
CREATE TABLE agent_events (
  id serial PRIMARY KEY,
  agent_id text NOT NULL,
  event_type text NOT NULL,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  agent_type text,
  agent_name text,
  project_dir text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_events_agent_created_idx ON agent_events (agent_id, created_at DESC);
CREATE INDEX agent_events_created_idx ON agent_events (created_at);
CREATE INDEX agent_events_type_idx ON agent_events (event_type);

-- The engine's stream as the host records it: assistant text, thoughts,
-- tool calls, plan and turn markers. Turns are assembled from these rows.
CREATE TABLE agent_stream_events (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan')),
  -- Stable key for rows that are updated in place (a tool call's result).
  key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, seq)
);

CREATE INDEX agent_stream_events_agent_created
  ON agent_stream_events (agent_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX agent_stream_events_agent_key
  ON agent_stream_events (agent_id, kind, key) WHERE key IS NOT NULL;

CREATE TABLE agent_token_usage (
  id serial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  session_id text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cache_creation_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  message_count integer NOT NULL DEFAULT 0,
  harvested_at timestamptz NOT NULL DEFAULT now(),
  session_start timestamptz,
  session_end timestamptz,
  UNIQUE (agent_id, session_id, model)
);

CREATE INDEX agent_token_usage_agent_idx ON agent_token_usage (agent_id);
CREATE INDEX agent_token_usage_session_start_idx ON agent_token_usage (session_start);

-- ── Streams and blocks (docs/design/blocks.md) ───────────────────────────
-- One stream per root agent; a block is one post in it by an agent or a
-- person, optionally addressed to an agent (delivered as a prompt) and
-- optionally replying under another block (a thread). No FK to agents:
-- a root's history stays readable after its children are gone.

CREATE TABLE blocks (
  id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  author_agent_id text,
  -- The agent that receives this block as a prompt; NULL = for people.
  to_agent_id text,
  kind text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review', 'tasks')),
  -- The top-level block this replies under, and the block replied to.
  thread_id uuid,
  reply_to uuid,
  text text NOT NULL DEFAULT '',
  data jsonb,
  state jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'launch': the launch-context post. 'turn': an agent's answer for one
  -- turn. 'system_prompt': the guidance the agent was started with.
  origin text CHECK (origin IS NULL OR origin IN ('launch', 'turn', 'system_prompt')), -- widened in 0003
  launched_by_agent_id text,
  -- Blocks with to_agent_id: whether the prompt reached every agent it was
  -- addressed to; NULL while pending. Per-recipient outcomes live in
  -- `deliveries` (0002).
  delivered boolean,
  -- Agent blocks for people: when the user saw it.
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (author_kind <> 'agent' OR author_agent_id IS NOT NULL),
  CHECK (thread_id IS NULL OR reply_to IS NOT NULL)
);

CREATE INDEX blocks_stream_created_idx
  ON blocks (stream_id, created_at DESC, id DESC);
CREATE INDEX blocks_thread_created_idx
  ON blocks (thread_id, created_at, id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX blocks_stream_unread_idx
  ON blocks (stream_id)
  WHERE author_kind = 'agent' AND to_agent_id IS NULL AND read_at IS NULL;
CREATE INDEX blocks_pending_delivery_idx
  ON blocks (stream_id, to_agent_id)
  WHERE to_agent_id IS NOT NULL AND delivered IS NULL;
-- Open input blocks addressed to people: what "Waiting" means.
CREATE INDEX blocks_open_input_idx
  ON blocks (stream_id, author_agent_id)
  WHERE kind IN ('question', 'form')
    AND to_agent_id IS NULL
    AND thread_id IS NULL
    AND (state IS NULL OR (state->'answer' IS NULL AND state->'submission' IS NULL));
CREATE INDEX blocks_attachments_gin
  ON blocks USING gin (attachments jsonb_path_ops);

-- One row per (block, author, emoji). NULLS NOT DISTINCT: a user reaction
-- has no agent id, and a plain UNIQUE would let a double click store two.
CREATE TABLE block_reactions (
  id uuid PRIMARY KEY,
  block_id uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  stream_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  author_agent_id text,
  emoji text NOT NULL,
  -- User reactions on an agent's block: delivery outcome; NULL while pending.
  delivered boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (block_id, author_kind, author_agent_id, emoji)
);

CREATE INDEX block_reactions_pending_idx
  ON block_reactions (stream_id)
  WHERE author_kind = 'user' AND delivered IS NULL;

-- ── Files ────────────────────────────────────────────────────────────────

CREATE TABLE files (
  id serial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  file_name text NOT NULL,
  source text NOT NULL DEFAULT 'screenshot',
  size_bytes integer NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX files_agent_idx ON files (agent_id);

CREATE TABLE files_seen (
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  file_key text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, file_key)
);

CREATE TABLE simulator_reservations (
  udid text PRIMARY KEY,
  agent_id text,
  status text NOT NULL DEFAULT 'free',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Templates, jobs ──────────────────────────────────────────────────────

CREATE TABLE templates (
  id text PRIMARY KEY,
  directory text NOT NULL,
  name text NOT NULL,
  description text,
  prompt text,
  agent_type text NOT NULL DEFAULT 'claude',
  model text,
  use_worktree boolean NOT NULL DEFAULT false,
  base_branch text,
  branch_name text,
  full_access boolean NOT NULL DEFAULT false,
  callable boolean NOT NULL DEFAULT true,
  allow_files boolean NOT NULL DEFAULT true,
  self_improve boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (directory, name)
);

CREATE INDEX templates_directory_idx ON templates (directory);
CREATE INDEX templates_callable_idx ON templates (callable) WHERE callable = true;

ALTER TABLE agents
  ADD CONSTRAINT agents_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES templates (id) ON DELETE SET NULL;

CREATE TABLE jobs (
  id text PRIMARY KEY,
  directory text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  agent_type text NOT NULL DEFAULT 'codex',
  model text,
  use_worktree boolean NOT NULL DEFAULT false,
  branch_name text,
  base_branch text,
  full_access boolean NOT NULL DEFAULT false,
  schedule text,
  timeout_ms integer,
  needs_input_timeout_ms integer,
  notify jsonb,
  prompt text,
  auto_archive boolean NOT NULL DEFAULT true,
  callable boolean NOT NULL DEFAULT false,
  singleton boolean NOT NULL DEFAULT true,
  template_id text REFERENCES templates (id) ON DELETE SET NULL,
  default_args jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_enabled boolean NOT NULL DEFAULT false,
  webhook_secret text,
  self_improve boolean NOT NULL DEFAULT false,
  continuation_enabled boolean NOT NULL DEFAULT false,
  max_iterations integer,
  completion_criteria text[],
  recovery_instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_max_iterations_positive
    CHECK (max_iterations IS NULL OR max_iterations > 0)
);

CREATE UNIQUE INDEX jobs_directory_name_key ON jobs (directory, name);
CREATE UNIQUE INDEX jobs_webhook_secret_unique ON jobs (webhook_secret)
  WHERE webhook_secret IS NOT NULL;
CREATE INDEX jobs_directory_idx ON jobs (directory);
CREATE INDEX jobs_name_idx ON jobs (name);
CREATE INDEX jobs_template_idx ON jobs (template_id);

CREATE TABLE job_runs (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  agent_id text REFERENCES agents (id) ON DELETE SET NULL,
  status text NOT NULL,
  report jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_question text,
  continuation jsonb,
  chain_id text,
  chain_iteration integer,
  continuation_pending boolean NOT NULL DEFAULT false,
  continuation_retries integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_runs_job_idx ON job_runs (job_id);
CREATE INDEX job_runs_agent_idx ON job_runs (agent_id);
CREATE INDEX job_runs_status_idx ON job_runs (status);
CREATE INDEX job_runs_started_idx ON job_runs (started_at);
CREATE INDEX job_runs_continuation_pending_idx ON job_runs (job_id)
  WHERE continuation_pending = true;

-- ── Brain: repo-scoped shared memory ─────────────────────────────────────

CREATE TABLE brain_objects (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  value jsonb NOT NULL,
  revision integer NOT NULL,
  created_by_agent_id text NOT NULL,
  updated_by_agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_root, collection, name)
);

CREATE INDEX brain_objects_repo_collection_updated_idx
  ON brain_objects (repo_root, collection, updated_at DESC);

CREATE TABLE brain_lists (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  revision integer NOT NULL,
  created_by_agent_id text NOT NULL,
  updated_by_agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_root, collection, name)
);

CREATE INDEX brain_lists_repo_collection_updated_idx
  ON brain_lists (repo_root, collection, updated_at DESC);

CREATE TABLE brain_list_items (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  item_index integer NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_root, collection, name, item_index),
  FOREIGN KEY (repo_root, collection, name)
    REFERENCES brain_lists (repo_root, collection, name) ON DELETE CASCADE
);

CREATE INDEX brain_list_items_repo_collection_name_idx
  ON brain_list_items (repo_root, collection, name, item_index);

CREATE TABLE brain_events (
  id uuid PRIMARY KEY,
  repo_root text NOT NULL,
  collection text NOT NULL,
  kind text NOT NULL,
  subject text,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  value jsonb NOT NULL,
  agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brain_events_repo_collection_created_idx
  ON brain_events (repo_root, collection, created_at DESC);
CREATE INDEX brain_events_repo_collection_kind_created_idx
  ON brain_events (repo_root, collection, kind, created_at DESC);
CREATE INDEX brain_events_repo_collection_subject_created_idx
  ON brain_events (repo_root, collection, subject, created_at DESC);
CREATE INDEX brain_events_tags_gin_idx ON brain_events USING gin (tags);

-- ── Settings, auth, personalities, quick phrases ─────────────────────────

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE personalities (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quick_phrases (
  id text PRIMARY KEY,
  label text CHECK (label IS NULL OR (length(label) > 0 AND length(label) <= 200)),
  text text NOT NULL CHECK (length(text) > 0 AND length(text) <= 1000),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Browser extension ────────────────────────────────────────────────────

CREATE TABLE browser_extension_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  device_name text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['agents:read', 'submissions:write'],
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX browser_extension_tokens_active_idx
  ON browser_extension_tokens (token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE browser_extension_pairings (
  id uuid PRIMARY KEY,
  pairing_secret_hash text NOT NULL,
  code_hash text NOT NULL,
  device_name text NOT NULL,
  dispatch_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  exchanged_at timestamptz,
  token_ciphertext text,
  token_iv text,
  token_auth_tag text,
  token_id uuid REFERENCES browser_extension_tokens (id) ON DELETE SET NULL
);

CREATE INDEX browser_extension_pairings_expires_idx
  ON browser_extension_pairings (expires_at);

CREATE TABLE browser_feedback_submissions (
  id uuid PRIMARY KEY,
  token_id uuid REFERENCES browser_extension_tokens (id) ON DELETE SET NULL,
  client_submission_id uuid NOT NULL,
  agent_id text NOT NULL,
  comment text NOT NULL,
  page_context jsonb NOT NULL,
  element_context jsonb NOT NULL,
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT browser_feedback_submissions_token_client_id_unique
    UNIQUE (token_id, client_submission_id)
);

CREATE INDEX browser_feedback_submissions_agent_created_idx
  ON browser_feedback_submissions (agent_id, created_at DESC);
CREATE INDEX browser_feedback_submissions_created_idx
  ON browser_feedback_submissions (created_at);
