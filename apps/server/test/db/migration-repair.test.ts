import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { setupTestDb, teardownTestDb, getTestDatabaseUrl } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("migration drift repair", () => {
  it("repairs databases where 0004 was recorded before all job columns existed", async () => {
    await runMigrations({
      databaseUrl: getTestDatabaseUrl(),
      count: 3,
    });

    await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule TEXT`);
    await pool.query(
      `INSERT INTO pgmigrations (name, run_on) VALUES ($1, NOW())`,
      ["0004_jobs-schedule"]
    );

    await expect(runMigrations(getTestDatabaseUrl())).resolves.not.toThrow();

    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'jobs'`
    );
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);

    expect(colNames).toContain("schedule");
    expect(colNames).toContain("timeout_ms");
    expect(colNames).toContain("needs_input_timeout_ms");
    expect(colNames).toContain("notify");
    expect(colNames).toContain("prompt");
    // file_path is dropped by migration 0008
    expect(colNames).not.toContain("file_path");

    const applied = await pool.query(`SELECT name FROM pgmigrations ORDER BY run_on`);
    const appliedNames = applied.rows.map((r: { name: string }) => r.name);
    expect(appliedNames).toContain("0006_jobs-schedule-repair");
    expect(appliedNames).toContain("0008_drop-jobs-file-path");
  });

  it("full migration run completes without errors on a fresh database", async () => {
    await pool.query(`DELETE FROM pgmigrations`);
    await pool.query(`DROP TABLE IF EXISTS job_runs CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS agent_feedback CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS agents CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS jobs CASCADE`);

    await expect(runMigrations(getTestDatabaseUrl())).resolves.not.toThrow();

    // Verify file_path column does not exist after all migrations
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'jobs' AND column_name = 'file_path'`
    );
    expect(cols.rowCount).toBe(0);

    // Verify the file_path unique constraint does not exist
    const constraints = await pool.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'jobs'::regclass
         AND contype = 'u'
         AND conname = 'jobs_directory_file_path_key'`
    );
    expect(constraints.rowCount).toBe(0);
  });
});
