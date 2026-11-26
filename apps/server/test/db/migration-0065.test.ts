import type { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./setup.js";

afterEach(teardownTestDb);

async function seed(
  pool: Pool,
  id: string,
  directory: string,
  projectId?: string
) {
  await pool.query(
    "INSERT INTO templates (id, name, directory, project_id) VALUES ($1, $1, $2, $3)",
    [id, directory, projectId]
  );
  await pool.query(
    "INSERT INTO jobs (id, name, directory, template_id) VALUES ($1, $1, $2, $1)",
    [id, directory]
  );
  await pool.query(
    "INSERT INTO job_runs (id, job_id, status, config) VALUES ($1, $1, 'completed', jsonb_build_object('directory', $2::text))",
    [id, directory]
  );
}

it.each([52, 64])(
  "re-encodes existing directories after %i migrations",
  async (count) => {
    const pool = await setupTestDb();
    const databaseUrl = getTestDatabaseUrl();
    await runMigrations({ databaseUrl, count });
    await pool.query(
      "INSERT INTO projects (id, name, repo_root, color) VALUES ('project', 'Project', '/tmp/project', '#336699')"
    );
    await seed(pool, "local", "/tmp/folder");
    await seed(pool, "other", "/tmp/other", "project");
    await runMigrations(databaseUrl);

    for (const table of ["templates", "jobs", "job_runs"]) {
      const directory =
        table === "job_runs" ? "config->>'directory'" : "directory";
      expect(
        (
          await pool.query(
            `SELECT ${directory} AS directory, location FROM ${table} ORDER BY id`
          )
        ).rows
      ).toEqual([
        {
          directory: "/tmp/folder",
          location: { runner: "local", path: "/tmp/folder" },
        },
        {
          directory: "/tmp/other",
          location: { runner: "local", path: "/tmp/other" },
        },
      ]);
    }

    // An older controller can still insert and edit records using directory alone.
    await seed(pool, "rollback", "/tmp/new");
    await pool.query(
      "UPDATE jobs SET directory = '/tmp/moved' WHERE id = 'local'"
    );
    expect(
      (
        await pool.query(
          "SELECT directory, location FROM jobs WHERE id IN ('local', 'rollback') ORDER BY id"
        )
      ).rows
    ).toEqual([
      { directory: "/tmp/moved", location: null },
      { directory: "/tmp/new", location: null },
    ]);
  }
);
