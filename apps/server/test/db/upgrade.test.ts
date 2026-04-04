/**
 * Upgrade integration test.
 *
 * Simulates upgrading from a previous Dispatch version by:
 * 1. Applying the v0.9.11 schema via raw SQL (no pgmigrations table)
 * 2. Seeding representative data across all tables
 * 3. Running current migrations via node-pg-migrate
 * 4. Verifying all seeded data survives and is queryable
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { setupTestDb, teardownTestDb, getTestDatabaseUrl } from "./setup.js";

// The v0.9.11 schema — applied via raw SQL to simulate a pre-migration install.
const V0_9_11_SCHEMA = `
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

  ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_type TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_message TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_metadata JSONB;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS latest_event_updated_at TIMESTAMPTZ;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context JSONB;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context_stale BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_context_updated_at TIMESTAMPTZ;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS worktree_path TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS worktree_branch TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS setup_phase TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona_context TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS pins JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS archive_phase TEXT;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS archive_cleanup_mode TEXT;

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
  ALTER TABLE media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

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
  ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS agent_type TEXT;
  ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS agent_name TEXT;
  ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS project_dir TEXT;

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
`;

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("upgrade from v0.9.11", () => {
  it("should apply old schema and seed data", async () => {
    // Step 1: Apply the old schema (no pgmigrations table)
    await pool.query(V0_9_11_SCHEMA);

    // Step 2: Seed representative data across all tables
    await pool.query(`
      INSERT INTO agents (id, name, type, status, cwd, full_access, codex_args, pins)
      VALUES
        ('agent-1', 'My Agent', 'claude-code', 'running', '/home/user/project', true, '["--model", "opus"]'::jsonb, '[{"label":"API","value":"http://localhost:3000","type":"url"}]'::jsonb),
        ('agent-2', 'Helper', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb)
    `);

    await pool.query(`
      INSERT INTO media (agent_id, file_name, source, size_bytes, description)
      VALUES
        ('agent-1', 'screenshot-001.png', 'screenshot', 204800, 'Login page'),
        ('agent-1', 'screenshot-002.png', 'screenshot', 102400, NULL),
        ('agent-2', 'output.png', 'screenshot', 51200, 'Final result')
    `);

    await pool.query(`
      INSERT INTO media_seen (agent_id, media_key)
      VALUES ('agent-1', 'screenshot-001.png')
    `);

    await pool.query(`
      INSERT INTO settings (key, value) VALUES ('worktreeLocation', 'sibling')
    `);

    await pool.query(`
      INSERT INTO sessions (token, expires_at)
      VALUES ('test-session-token', NOW() + INTERVAL '24 hours')
    `);

    await pool.query(`
      INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
      VALUES
        ('agent-1', 'working', 'Reading files', '{"phase":"research"}'::jsonb, 'claude-code', 'My Agent', '/home/user/project'),
        ('agent-1', 'done', 'Task complete', '{}'::jsonb, 'claude-code', 'My Agent', '/home/user/project')
    `);

    await pool.query(`
      INSERT INTO agent_token_usage (agent_id, session_id, model, input_tokens, output_tokens, cache_read_tokens, message_count, session_start)
      VALUES ('agent-1', 'sess-abc', 'claude-opus-4-6', 15000, 3000, 5000, 12, NOW() - INTERVAL '1 hour')
    `);

    await pool.query(`
      INSERT INTO agent_feedback (agent_id, severity, file_path, line_number, description, suggestion, status)
      VALUES ('agent-1', 'warning', 'src/index.ts', 42, 'Unused import', 'Remove the import', 'open')
    `);

    await pool.query(`
      INSERT INTO simulator_reservations (udid, agent_id, status)
      VALUES ('UDID-1234', 'agent-1', 'reserved')
    `);

    // Verify no pgmigrations table exists yet
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pgmigrations'`
    );
    expect(tables.rowCount).toBe(0);
  });

  it("should run current migrations on top of existing schema without errors", async () => {
    await runMigrations(getTestDatabaseUrl());

    // pgmigrations table should now exist with the baseline recorded
    const result = await pool.query(`SELECT name FROM pgmigrations ORDER BY run_on`);
    const names = result.rows.map((r: { name: string }) => r.name);
    expect(names).toContain("0001_baseline");
  });

  it("should preserve all seeded agents", async () => {
    const agents = await pool.query(`SELECT * FROM agents ORDER BY id`);
    expect(agents.rowCount).toBe(2);

    const agent1 = agents.rows[0];
    expect(agent1.id).toBe("agent-1");
    expect(agent1.name).toBe("My Agent");
    expect(agent1.type).toBe("claude-code");
    expect(agent1.status).toBe("running");
    expect(agent1.full_access).toBe(true);
    expect(agent1.codex_args).toEqual(["--model", "opus"]);
    expect(agent1.pins).toEqual([{ label: "API", value: "http://localhost:3000", type: "url" }]);

    const agent2 = agents.rows[1];
    expect(agent2.id).toBe("agent-2");
    expect(agent2.type).toBe("codex");
    expect(agent2.status).toBe("stopped");
  });

  it("should preserve all seeded media with descriptions", async () => {
    const media = await pool.query(`SELECT * FROM media ORDER BY file_name`);
    expect(media.rowCount).toBe(3);
    expect(media.rows[0].description).toBe("Final result");
    expect(media.rows[1].description).toBe("Login page");
    expect(media.rows[2].description).toBeNull();
  });

  it("should preserve media_seen records", async () => {
    const seen = await pool.query(`SELECT * FROM media_seen`);
    expect(seen.rowCount).toBe(1);
    expect(seen.rows[0].agent_id).toBe("agent-1");
    expect(seen.rows[0].media_key).toBe("screenshot-001.png");
  });

  it("should preserve settings", async () => {
    const settings = await pool.query(`SELECT * FROM settings WHERE key = 'worktreeLocation'`);
    expect(settings.rowCount).toBe(1);
    expect(settings.rows[0].value).toBe("sibling");
  });

  it("should preserve sessions", async () => {
    const sessions = await pool.query(`SELECT * FROM sessions WHERE token = 'test-session-token'`);
    expect(sessions.rowCount).toBe(1);
  });

  it("should preserve agent events with all columns", async () => {
    const events = await pool.query(`SELECT * FROM agent_events ORDER BY id`);
    expect(events.rowCount).toBe(2);
    expect(events.rows[0].event_type).toBe("working");
    expect(events.rows[0].agent_type).toBe("claude-code");
    expect(events.rows[0].project_dir).toBe("/home/user/project");
    expect(events.rows[1].event_type).toBe("done");
  });

  it("should preserve token usage records", async () => {
    const usage = await pool.query(`SELECT * FROM agent_token_usage WHERE agent_id = 'agent-1'`);
    expect(usage.rowCount).toBe(1);
    expect(usage.rows[0].model).toBe("claude-opus-4-6");
    expect(usage.rows[0].input_tokens).toBe(15000);
    expect(usage.rows[0].output_tokens).toBe(3000);
    expect(usage.rows[0].cache_read_tokens).toBe(5000);
  });

  it("should preserve feedback records", async () => {
    const feedback = await pool.query(`SELECT * FROM agent_feedback WHERE agent_id = 'agent-1'`);
    expect(feedback.rowCount).toBe(1);
    expect(feedback.rows[0].severity).toBe("warning");
    expect(feedback.rows[0].file_path).toBe("src/index.ts");
    expect(feedback.rows[0].line_number).toBe(42);
    expect(feedback.rows[0].suggestion).toBe("Remove the import");
  });

  it("should preserve simulator reservations", async () => {
    const res = await pool.query(`SELECT * FROM simulator_reservations WHERE udid = 'UDID-1234'`);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].agent_id).toBe("agent-1");
    expect(res.rows[0].status).toBe("reserved");
  });

  it("should still enforce cascade deletes after upgrade", async () => {
    await pool.query(`DELETE FROM agents WHERE id = 'agent-1'`);

    const media = await pool.query(`SELECT * FROM media WHERE agent_id = 'agent-1'`);
    const seen = await pool.query(`SELECT * FROM media_seen WHERE agent_id = 'agent-1'`);
    const feedback = await pool.query(`SELECT * FROM agent_feedback WHERE agent_id = 'agent-1'`);
    const usage = await pool.query(`SELECT * FROM agent_token_usage WHERE agent_id = 'agent-1'`);

    expect(media.rowCount).toBe(0);
    expect(seen.rowCount).toBe(0);
    expect(feedback.rowCount).toBe(0);
    expect(usage.rowCount).toBe(0);
  });
});
