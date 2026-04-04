/**
 * Test database helpers.
 *
 * Creates an isolated test database per suite so tests don't interfere with
 * each other or the production database.
 */
import { Pool } from "pg";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://dispatch:dispatch@127.0.0.1:5432/postgres";

let testDbName: string;
let adminPool: Pool;
let testPool: Pool;

/**
 * Create a fresh test database and return a connected pool.
 * Call this in `beforeAll`.
 */
export async function setupTestDb(): Promise<Pool> {
  testDbName = `dispatch_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 2 });
  adminPool.on("error", () => {});

  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  const connStr = ADMIN_DATABASE_URL.replace(/\/[^/]+$/, `/${testDbName}`);
  testPool = new Pool({ connectionString: connStr, max: 5 });
  testPool.on("error", () => {});

  return testPool;
}

/**
 * Drop the test database. Call this in `afterAll`.
 */
export async function teardownTestDb(): Promise<void> {
  if (testPool) {
    await testPool.end();
  }
  if (adminPool && testDbName) {
    // Terminate remaining connections before drop
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  }
}

/**
 * Run the migration SQL against the given pool (same SQL as src/db/migrate.ts
 * but without the media file-system migration).
 */
export async function runTestMigrations(pool: Pool): Promise<void> {
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

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS media_dir TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'codex';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS codex_args JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS full_access BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_type TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_message TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_metadata JSONB;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_updated_at TIMESTAMPTZ;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context JSONB;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context_stale BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context_updated_at TIMESTAMPTZ;

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

    ALTER TABLE media ADD COLUMN IF NOT EXISTS description TEXT;

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS worktree_path TEXT;

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS worktree_branch TEXT;

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS setup_phase TEXT;

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS agent_events (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS agent_type TEXT;
    ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS agent_name TEXT;
    ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS project_dir TEXT;

    -- Persona support
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona_context TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS claude_session_id TEXT;

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

    -- Agent pins
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS pins JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- Async archival phase tracking
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS archive_phase TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS archive_cleanup_mode TEXT;
  `;

  await pool.query(sql);
}
