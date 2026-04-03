import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import { loadConfig } from "../config.js";
import { createPool } from "./client.js";

export async function runMigrations(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  const sql = `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'codex',
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      tmux_session TEXT,
      simulator_udid TEXT,
      media_dir TEXT,
      codex_args JSONB NOT NULL DEFAULT '[]'::jsonb,
      full_access BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS media_dir TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'codex';

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS codex_args JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS full_access BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS last_error TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS latest_event_type TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS latest_event_message TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS latest_event_metadata JSONB;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS latest_event_updated_at TIMESTAMPTZ;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS git_context JSONB;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS git_context_stale BOOLEAN NOT NULL DEFAULT true;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS git_context_updated_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS simulator_reservations (
      udid TEXT PRIMARY KEY,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'free',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS media_seen (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, media_key)
    );

    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'screenshot',
      size_bytes INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_media_agent_id ON media(agent_id);

    ALTER TABLE media
      ADD COLUMN IF NOT EXISTS description TEXT;

    ALTER TABLE media
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS worktree_path TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS worktree_branch TEXT;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS setup_phase TEXT;

    CREATE TABLE IF NOT EXISTS agent_events (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_events_agent_id ON agent_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_events_created_at ON agent_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type);

    ALTER TABLE agent_events
      ADD COLUMN IF NOT EXISTS agent_type TEXT;

    ALTER TABLE agent_events
      ADD COLUMN IF NOT EXISTS agent_name TEXT;

    ALTER TABLE agent_events
      ADD COLUMN IF NOT EXISTS project_dir TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS agent_token_usage (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      harvested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_start TIMESTAMPTZ,
      session_end TIMESTAMPTZ,
      UNIQUE (agent_id, session_id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_atu_agent_id ON agent_token_usage(agent_id);
    CREATE INDEX IF NOT EXISTS idx_atu_session_start ON agent_token_usage(session_start);

    -- Persona support
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona_context TEXT;

    CREATE TABLE IF NOT EXISTS agent_feedback (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      severity TEXT NOT NULL DEFAULT 'info',
      file_path TEXT,
      line_number INTEGER,
      description TEXT NOT NULL,
      suggestion TEXT,
      media_ref TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent_id ON agent_feedback(agent_id);

    -- Agent pins (key-value info surfaced in UI)
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS pins JSONB NOT NULL DEFAULT '[]'::jsonb;
  `;

  try {
    await pool.query(sql);
    console.log("Migrations completed.");
    await migrateExistingMedia(pool, config.mediaRoot);
  } finally {
    await pool.end();
  }
}

const MEDIA_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|mp4)$/i;

async function migrateExistingMedia(
  pool: import("pg").Pool,
  mediaRoot: string
): Promise<void> {
  const agents = await pool.query<{ id: string; media_dir: string | null }>(
    "SELECT id, media_dir FROM agents"
  );

  let inserted = 0;
  for (const agent of agents.rows) {
    const mediaDir = agent.media_dir ?? path.join(mediaRoot, agent.id);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(mediaDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !MEDIA_EXTENSIONS.test(entry.name)) {
        continue;
      }

      const filePath = path.join(mediaDir, entry.name);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      const exists = await pool.query(
        "SELECT 1 FROM media WHERE agent_id = $1 AND file_name = $2",
        [agent.id, entry.name]
      );
      if (exists.rowCount && exists.rowCount > 0) continue;

      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
         VALUES ($1, $2, 'screenshot', $3, $4)`,
        [agent.id, entry.name, fileStat.size, fileStat.mtime]
      );
      inserted++;
    }
  }

  if (inserted > 0) {
    console.log(`Data migration: inserted ${inserted} existing media records.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  });
}
