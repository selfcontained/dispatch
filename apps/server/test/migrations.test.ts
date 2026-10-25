import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

async function reactionUniqueness(): Promise<{
  constraints: string[];
  index: string | null;
}> {
  const constraints = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'block_reactions'::regclass AND contype = 'u'`
  );
  const index = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'block_reactions' AND indexname = 'block_reactions_unique_idx'`
  );
  return {
    constraints: constraints.rows.map((row) => row.conname),
    index: index.rows[0]?.indexdef ?? null,
  };
}

describe("block_reactions uniqueness migration", () => {
  it("builds the COALESCE unique index on a fresh database", async () => {
    const state = await reactionUniqueness();
    expect(state.constraints).toEqual([]);
    expect(state.index).toContain("COALESCE(author_agent_id, ''::text)");
  });

  it("replaces the NULLS NOT DISTINCT constraint left by the old baseline", async (ctx) => {
    const version = await pool.query<{ num: number }>(
      "SELECT current_setting('server_version_num')::int AS num"
    );
    // The old baseline's syntax is what PG 14 rejects, so it can't be recreated there.
    if (version.rows[0]!.num < 150000) ctx.skip();

    await pool.query(`DROP INDEX block_reactions_unique_idx`);
    await pool.query(
      `ALTER TABLE block_reactions
         ADD UNIQUE NULLS NOT DISTINCT (block_id, author_kind, author_agent_id, emoji)`
    );
    // Remove the later migration too: the runner rejects replaying an older
    // migration beneath an already-applied successor.
    await dropTasks();
    await pool.query("ALTER TABLE agents DROP COLUMN project_id");
    await pool.query("ALTER TABLE templates DROP COLUMN project_id");
    await pool.query("DROP TABLE projects");
    await pool.query("ALTER TABLE templates DROP COLUMN persona");
    await pool.query("ALTER TABLE jobs DROP COLUMN persona");
    await pool.query("DROP TABLE block_delivery_context");
    await pool.query("DROP TABLE scheduled_messages");
    await pool.query(
      `DELETE FROM pgmigrations WHERE name IN ('0016_block_reactions_pg14_unique', '0017_scheduled_messages', '0018_message_context', '0019_launch_personas', '0020_persona_agent_roles', '0021_projects', '0022_project_icons')`
    );

    await runTestMigrations();

    const state = await reactionUniqueness();
    expect(state.constraints).toEqual([]);
    expect(state.index).toContain("COALESCE(author_agent_id, ''::text)");
  });
});

/** Rewinds 0025, 0024 and 0023, which depends on projects and agents, so older eras can replay. */
async function dropTasks(): Promise<void> {
  await pool.query(
    "DROP TABLE IF EXISTS task_watches, task_attachments, task_events, task_agents, tasks, task_columns"
  );
  await pool.query(
    "DELETE FROM pgmigrations WHERE name IN ('0023_tasks', '0024_task_attachments', '0025_task_archive', '0026_task_watches')"
  );
}

describe("Project upgrade ordering", () => {
  it("upgrades an existing persona-era database", async () => {
    await dropTasks();
    await pool.query("ALTER TABLE agents DROP COLUMN project_id");
    await pool.query("ALTER TABLE templates DROP COLUMN project_id");
    await pool.query("DROP TABLE projects");
    await pool.query(
      "DELETE FROM pgmigrations WHERE name IN ('0021_projects', '0022_project_icons')"
    );
    const released = await pool.query(
      "SELECT name FROM pgmigrations WHERE name IN ('0019_launch_personas', '0020_persona_agent_roles')"
    );
    expect(released.rows).toHaveLength(2);
    await runTestMigrations();
    await pool.query("SELECT project_id FROM agents LIMIT 0");
    await pool.query("SELECT icon_data, icon_mime FROM projects LIMIT 0");
    await pool.query("SELECT project_id FROM tasks LIMIT 0");
  });

  it("preserves preview projects while replaying at the new sequence", async () => {
    await pool.query(
      "INSERT INTO projects (id, name, repo_root, icon_data, icon_mime) VALUES ('preview', 'Preview', '/tmp/preview', 'logo'::bytea, 'image/svg+xml')"
    );
    await pool.query(
      "UPDATE pgmigrations SET name = CASE name WHEN '0021_projects' THEN '0019_projects' WHEN '0022_project_icons' THEN '0020_project_icons' ELSE name END"
    );
    await dropTasks();
    await pool.query(
      "DELETE FROM pgmigrations WHERE name IN ('0019_launch_personas', '0020_persona_agent_roles')"
    );
    await pool.query("ALTER TABLE templates DROP COLUMN persona");
    await pool.query("ALTER TABLE jobs DROP COLUMN persona");
    await runTestMigrations();
    const result = await pool.query(
      "SELECT name, icon_data FROM projects WHERE id='preview'"
    );
    expect(result.rows[0].name).toBe("Preview");
    expect(result.rows[0].icon_data.toString()).toBe("logo");
  });
});
