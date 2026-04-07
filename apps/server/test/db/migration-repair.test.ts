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

    const applied = await pool.query(`SELECT name FROM pgmigrations ORDER BY run_on`);
    const appliedNames = applied.rows.map((r: { name: string }) => r.name);
    expect(appliedNames).toContain("0006_jobs-schedule-repair");
  });

  it("allows 0005 to be safely re-run during manual recovery", async () => {
    await pool.query(
      `DELETE FROM pgmigrations
       WHERE name IN ('0005_jobs-file-path-unique', '0006_jobs-schedule-repair')
          OR name > '0006'`
    );

    await expect(runMigrations(getTestDatabaseUrl())).resolves.not.toThrow();

    const constraints = await pool.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'jobs'::regclass
         AND contype = 'u'
         AND conname = 'jobs_directory_file_path_key'`
    );
    expect(constraints.rowCount).toBe(1);
  });

  it("treats an equivalent standalone unique index as satisfying 0005", async () => {
    await pool.query(`DELETE FROM pgmigrations`);
    await pool.query(`DROP TABLE IF EXISTS job_runs`);
    await pool.query(`DROP TABLE IF EXISTS jobs`);

    await runMigrations({
      databaseUrl: getTestDatabaseUrl(),
      count: 4,
    });
    await pool.query(`DROP INDEX IF EXISTS jobs_directory_file_path_key`);
    await pool.query(
      `CREATE UNIQUE INDEX jobs_directory_file_path_key ON jobs (directory, file_path)`
    );

    await expect(runMigrations(getTestDatabaseUrl())).resolves.not.toThrow();

    const indexes = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'jobs'
         AND indexname = 'jobs_directory_file_path_key'`
    );
    expect(indexes.rowCount).toBe(1);
  });
});
