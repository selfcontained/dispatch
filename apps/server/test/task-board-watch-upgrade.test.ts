import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { migrationFiles } from "../src/generated/runtime-assets.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  const beforeBoard = migrationFiles.findIndex(
    (file) => file.name === "0030_task_board_watches.sql"
  );
  expect(beforeBoard).toBeGreaterThan(0);
  await runMigrations({
    databaseUrl: getTestDatabaseUrl(),
    count: beforeBoard,
  });
});
afterAll(teardownTestDb);

it("upgrades valid explicit watches and pending activity without replay or loss, with lifecycle cascades", async () => {
  await pool.query(
    `INSERT INTO projects (id, name, repo_root, color) VALUES ('prj_upgrade', 'Upgrade', '/tmp/board-upgrade', '#336699')`
  );
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_upgrade', 'Upgrade', '/tmp', 'running')`
  );
  await pool.query(
    `INSERT INTO task_columns (id, project_id, key, name, position) VALUES ('col_upgrade', 'prj_upgrade', 'backlog', 'Backlog', 0)`
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, column_id, title, position, created_by_kind) VALUES ('tsk_upgrade', 'prj_upgrade', 'col_upgrade', 'Upgrade', 0, 'user')`
  );
  await pool.query(
    `INSERT INTO task_watches (task_id, agent_id) VALUES ('tsk_upgrade', 'agt_upgrade')`
  );
  await pool.query(
    `INSERT INTO task_events (id, task_id, kind, actor_kind, data) VALUES (gen_random_uuid(), 'tsk_upgrade', 'created', 'user', '{}')`
  );
  const old = (
    await pool.query(
      `SELECT task_id, agent_id, source, item_id, created_at FROM task_watch_items`
    )
  ).rows;
  expect(old).toHaveLength(1);
  await runMigrations(getTestDatabaseUrl());
  expect(
    (
      await pool.query(
        `SELECT task_id, agent_id, source, item_id, created_at FROM task_watch_items`
      )
    ).rows
  ).toEqual(old);
  expect(
    (
      await pool.query(
        `SELECT * FROM task_watch_items WHERE watch_id IS NOT NULL AND board_watch_id IS NULL`
      )
    ).rows
  ).toHaveLength(1);
  await pool.query(
    `INSERT INTO task_board_watches (project_id, agent_id) VALUES ('prj_upgrade', 'agt_upgrade')`
  );
  expect(
    (await pool.query(`SELECT * FROM task_watch_items`)).rows
  ).toHaveLength(1);
  await pool.query(`DELETE FROM task_watches`);
  expect(
    (await pool.query(`SELECT * FROM task_watch_items`)).rows
  ).toHaveLength(0);
  await pool.query(
    `INSERT INTO task_events (id, task_id, kind, actor_kind, data) VALUES (gen_random_uuid(), 'tsk_upgrade', 'updated', 'user', '{"fields":["body"]}')`
  );
  expect(
    (
      await pool.query(
        `SELECT * FROM task_watch_items WHERE board_watch_id IS NOT NULL`
      )
    ).rows
  ).toHaveLength(1);
  await pool.query(`DELETE FROM tasks`);
  expect(
    (await pool.query(`SELECT * FROM task_watch_items`)).rows
  ).toHaveLength(0);
  expect(
    (await pool.query(`SELECT * FROM task_board_watches`)).rows
  ).toHaveLength(1);
  await pool.query(`DELETE FROM agents`);
  expect(
    (await pool.query(`SELECT * FROM task_board_watches`)).rows
  ).toHaveLength(0);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_upgrade2', 'Upgrade2', '/tmp', 'running')`
  );
  await pool.query(
    `INSERT INTO task_board_watches (project_id, agent_id) VALUES ('prj_upgrade', 'agt_upgrade2')`
  );
  await pool.query(`DELETE FROM projects`);
  expect(
    (await pool.query(`SELECT * FROM task_board_watches`)).rows
  ).toHaveLength(0);
});
