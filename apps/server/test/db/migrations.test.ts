import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("migrations", () => {
  it("should apply cleanly to a fresh database", async () => {
    await runTestMigrations();

    // Verify core tables exist
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    const tableNames = tables.rows.map((r: { table_name: string }) => r.table_name);
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("media");
    expect(tableNames).toContain("media_seen");
    expect(tableNames).toContain("simulator_reservations");
    expect(tableNames).toContain("pgmigrations");
  });

  it("should be idempotent (run twice without error)", async () => {
    // First run already happened above; run again
    await expect(runTestMigrations()).resolves.not.toThrow();
  });

  it("should have all expected columns on agents", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agents' ORDER BY ordinal_position`
    );
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);

    const expected = [
      "id", "name", "type", "status", "cwd",
      "tmux_session", "simulator_udid", "media_dir",
      "codex_args", "full_access", "last_error", "created_at", "updated_at",
      "latest_event_type", "latest_event_message",
      "latest_event_metadata", "latest_event_updated_at",
      "git_context", "git_context_stale", "git_context_updated_at",
      "worktree_path", "worktree_branch", "setup_phase", "deleted_at",
      "persona", "parent_agent_id", "persona_context",
      "pins", "archive_phase", "archive_cleanup_mode",
    ];

    for (const col of expected) {
      expect(colNames).toContain(col);
    }
  });

  it("should have ON DELETE CASCADE for media foreign keys", async () => {
    // Insert a test agent, then media, then delete the agent — media should cascade
    await pool.query(
      `INSERT INTO agents (id, name, status, cwd) VALUES ('test-cascade', 'Cascade Test', 'stopped', '/tmp')`
    );
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes) VALUES ('test-cascade', 'test.png', 'screenshot', 1024)`
    );
    await pool.query(
      `INSERT INTO media_seen (agent_id, media_key) VALUES ('test-cascade', 'test.png')`
    );

    // Delete the agent
    await pool.query(`DELETE FROM agents WHERE id = 'test-cascade'`);

    // Child rows should be gone
    const media = await pool.query(`SELECT * FROM media WHERE agent_id = 'test-cascade'`);
    const seen = await pool.query(`SELECT * FROM media_seen WHERE agent_id = 'test-cascade'`);
    expect(media.rowCount).toBe(0);
    expect(seen.rowCount).toBe(0);
  });

  it("should track migrations in pgmigrations table", async () => {
    const result = await pool.query(
      `SELECT name FROM pgmigrations ORDER BY run_on`
    );
    const names = result.rows.map((r: { name: string }) => r.name);
    expect(names).toContain("0001_baseline");
  });
});
