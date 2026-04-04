/**
 * Upgrade integration test.
 *
 * Dynamically tests that the latest migration doesn't break existing data:
 * 1. Runs all migrations except the last one
 * 2. Seeds representative data across all tables
 * 3. Applies the final migration
 * 4. Verifies all seeded data survives and is queryable
 *
 * When there's only one migration (the baseline), the test is skipped
 * since there's no upgrade path to test yet.
 */
import { readdirSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { runMigrations, migrationsDir } from "../../src/db/migrate.js";
import { setupTestDb, teardownTestDb, getTestDatabaseUrl } from "./setup.js";

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql") || f.endsWith(".ts") || f.endsWith(".js"))
  .sort();

const hasMigrationsToTest = migrationFiles.length > 1;

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe.skipIf(!hasMigrationsToTest)("upgrade: applying latest migration preserves existing data", () => {
  it("should apply all migrations except the last", async () => {
    const countBeforeLast = migrationFiles.length - 1;

    await runMigrations({
      databaseUrl: getTestDatabaseUrl(),
      count: countBeforeLast,
    });

    // Verify the last migration has NOT been applied
    const applied = await pool.query(`SELECT name FROM pgmigrations ORDER BY run_on`);
    const appliedNames = applied.rows.map((r: { name: string }) => r.name);
    expect(appliedNames).toHaveLength(countBeforeLast);

    const lastMigrationName = migrationFiles[migrationFiles.length - 1].replace(/\.[^.]+$/, "");
    expect(appliedNames).not.toContain(lastMigrationName);
  });

  it("should seed representative data", async () => {
    await pool.query(`
      INSERT INTO agents (id, name, type, status, cwd, full_access, codex_args, pins)
      VALUES
        ('agent-1', 'My Agent', 'claude-code', 'running', '/home/user/project', true,
         '["--model", "opus"]'::jsonb,
         '[{"label":"API","value":"http://localhost:3000","type":"url"}]'::jsonb),
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
  });

  it("should apply the latest migration without errors", async () => {
    // Run remaining migrations (just the last one)
    await runMigrations(getTestDatabaseUrl());

    // All migrations should now be applied
    const applied = await pool.query(`SELECT name FROM pgmigrations ORDER BY run_on`);
    expect(applied.rows).toHaveLength(migrationFiles.length);
  });

  it("should preserve agents with all fields intact", async () => {
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

  it("should preserve media with descriptions", async () => {
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

  it("should preserve agent events", async () => {
    const events = await pool.query(`SELECT * FROM agent_events ORDER BY id`);
    expect(events.rowCount).toBe(2);
    expect(events.rows[0].event_type).toBe("working");
    expect(events.rows[0].agent_type).toBe("claude-code");
    expect(events.rows[0].project_dir).toBe("/home/user/project");
  });

  it("should preserve token usage records", async () => {
    const usage = await pool.query(`SELECT * FROM agent_token_usage WHERE agent_id = 'agent-1'`);
    expect(usage.rowCount).toBe(1);
    expect(usage.rows[0].model).toBe("claude-opus-4-6");
    expect(usage.rows[0].input_tokens).toBe(15000);
    expect(usage.rows[0].output_tokens).toBe(3000);
  });

  it("should preserve feedback records", async () => {
    const feedback = await pool.query(`SELECT * FROM agent_feedback WHERE agent_id = 'agent-1'`);
    expect(feedback.rowCount).toBe(1);
    expect(feedback.rows[0].severity).toBe("warning");
    expect(feedback.rows[0].line_number).toBe(42);
  });

  it("should preserve simulator reservations", async () => {
    const res = await pool.query(`SELECT * FROM simulator_reservations WHERE udid = 'UDID-1234'`);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].agent_id).toBe("agent-1");
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
