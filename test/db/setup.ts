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

  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  const connStr = ADMIN_DATABASE_URL.replace(/\/[^/]+$/, `/${testDbName}`);
  testPool = new Pool({ connectionString: connStr, max: 5 });

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
  `;

  await pool.query(sql);
}
