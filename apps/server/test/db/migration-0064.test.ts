import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runner } from "node-pg-migrate";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { migrationFiles } from "../../src/generated/runtime-assets.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runMigrations({ databaseUrl: getTestDatabaseUrl(), count: 63 });
});

afterAll(teardownTestDb);

async function insertAgent(id: string, cwd: string) {
  // The older controller's writes omit runner_id.
  await pool.query(
    "INSERT INTO agents (id, name, status, cwd) VALUES ($1, $1, 'stopped', $2)",
    [id, cwd]
  );
}

it("backs up to main and upgrades again with old and new placements intact", async () => {
  await insertAgent("pre_local", "/tmp/repo");
  // The reserved registration must abort the migration before it adds the column.
  await pool.query(
    "INSERT INTO runner_registrations (id, name, endpoint_host) VALUES ('local', 'Reserved', 'localhost')"
  );
  await expect(runMigrations(getTestDatabaseUrl())).rejects.toThrow(
    'Runner registration "local" conflicts'
  );
  await pool.query("DELETE FROM runner_registrations WHERE id = 'local'");
  await runMigrations(getTestDatabaseUrl());

  await pool.query(
    "INSERT INTO agents(id,name,status,cwd,runner_id) VALUES ('enrolled','Enrolled','stopped','/srv/session','rnr_example')"
  );
  const mainDir = await mkdtemp(join(tmpdir(), "dispatch-main-migrations-"));
  try {
    // Main at the T07 base ships the shared prefix through 0052.
    await Promise.all(
      migrationFiles
        .filter(({ name }) => name.slice(0, 4) <= "0052")
        .map(({ name, sql }) => writeFile(join(mainDir, name), sql))
    );
    await runner({
      databaseUrl: getTestDatabaseUrl(),
      dir: mainDir,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => {},
    });
    // The rollback guarantee (runner_id defaults to 'local') holds for builds
    // without the runner feature: main can only create local agents.
    await insertAgent("main_new", "/tmp/from-main");
    await pool.query(
      "UPDATE agents SET cwd = '/tmp/moved' WHERE id = 'pre_local'"
    );
  } finally {
    await rm(mainDir, { recursive: true, force: true });
  }

  await runMigrations(getTestDatabaseUrl());
  expect(
    (await pool.query("SELECT id, runner_id, cwd FROM agents ORDER BY id")).rows
  ).toEqual([
    { id: "enrolled", runner_id: "rnr_example", cwd: "/srv/session" },
    { id: "main_new", runner_id: "local", cwd: "/tmp/from-main" },
    { id: "pre_local", runner_id: "local", cwd: "/tmp/moved" },
  ]);
});
