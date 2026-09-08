import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

// The names earlier prereleases of this branch wrote into pgmigrations for
// files this branch no longer ships (migrate.ts deletes them at boot).
const PRERELEASE_MIGRATION_NAMES = [
  "0048_agent-stream-events",
  "0049_agent-stream-events-turn",
  "0050_agent-chat-messages-delivery-text",
  "0051_agent-type-dispatch",
  "0052_agent-stream-events-turn",
  "0053_agent-chat-messages-delivery-text",
  "0054_agent-type-dispatch",
];

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("harness migrations", () => {
  it("re-run their SQL against an existing schema without error (every statement is guarded)", async () => {
    // node-pg-migrate skips names already in pgmigrations, so a plain second
    // run executes nothing. Forgetting the two rows makes it execute both
    // files again on a database that already has their objects: the case an
    // install upgraded from the earlier harness migrations is in.
    await pool.query(
      `DELETE FROM pgmigrations WHERE name IN ('0051_agent-stream-events', '0052_agent-chat-messages-delivery-text')`
    );
    await expect(runTestMigrations()).resolves.not.toThrow();
    const rows = await pool.query<{ name: string }>(
      `SELECT name FROM pgmigrations WHERE name IN ('0051_agent-stream-events', '0052_agent-chat-messages-delivery-text') ORDER BY name`
    );
    expect(rows.rows.map((r) => r.name)).toEqual([
      "0051_agent-stream-events",
      "0052_agent-chat-messages-delivery-text",
    ]);
  });

  it("accept a plan row and a delivery_text column", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_mig', 'M', '/tmp', 'running')`
    );
    await expect(
      pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
         VALUES ('agt_mig', 1, 'plan', 'plan:1', '{"entries":[]}'::jsonb)`
      )
    ).resolves.toBeDefined();
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_chat_messages' AND column_name = 'delivery_text'`
    );
    expect(column.rowCount).toBe(1);
    const index = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'agent_stream_events_agent_created'`
    );
    expect(index.rowCount).toBe(1);
  });

  it("boot on a database that ran an earlier prerelease of this branch", async () => {
    // The prerelease records are dated a year back on purpose. The runner
    // reads pgmigrations ordered by (run_on, id) and compares that list
    // against the shipped files position by position, so the dates decide
    // where the dead names land: ahead of the files this branch does ship,
    // where the prerelease wrote them, which is what makes the comparison
    // throw before the first migration executes.
    await pool.query(
      `INSERT INTO pgmigrations (name, run_on)
        SELECT name, NOW() - INTERVAL '1 year' FROM unnest($1::text[]) AS t(name)`,
      [PRERELEASE_MIGRATION_NAMES]
    );
    // 'dsh' is the agent type value one of those prereleases renamed in a
    // migration this branch does not ship. Every place that migration
    // rewrote is seeded here, because a value left behind in any of them
    // reads as the harness disappearing from that row.
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, type, review_agent_type)
        VALUES ('agt_prerelease', 'P', '/tmp', 'running', 'dsh', 'dsh')`
    );
    await pool.query(
      `INSERT INTO jobs (id, directory, name, agent_type)
        VALUES ('job_prerelease', '/tmp', 'nightly', 'dsh')`
    );
    await pool.query(
      `INSERT INTO templates (id, directory, name, prompt, agent_type)
        VALUES ('tpl_prerelease', '/tmp', 'review', 'go', 'dsh')`
    );
    await pool.query(
      `INSERT INTO agent_events (agent_id, event_type, message, agent_type)
        VALUES ('agt_prerelease', 'working', 'x', 'dsh')`
    );
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(["claude", "dsh", "terminal"])]
    );

    await expect(runTestMigrations()).resolves.not.toThrow();

    const dead = await pool.query<{ name: string }>(
      `SELECT name FROM pgmigrations WHERE name = ANY($1::text[])`,
      [PRERELEASE_MIGRATION_NAMES]
    );
    expect(dead.rows).toEqual([]);
    const live = await pool.query<{ name: string; count: string }>(
      `SELECT name, COUNT(*)::text AS count FROM pgmigrations
        WHERE name IN ('0051_agent-stream-events', '0052_agent-chat-messages-delivery-text')
        GROUP BY name ORDER BY name`
    );
    expect(live.rows).toEqual([
      { name: "0051_agent-stream-events", count: "1" },
      { name: "0052_agent-chat-messages-delivery-text", count: "1" },
    ]);
    const agent = await pool.query<{
      type: string;
      review_agent_type: string;
    }>(
      `SELECT type, review_agent_type FROM agents WHERE id = 'agt_prerelease'`
    );
    expect(agent.rows[0]).toEqual({
      type: "dispatch",
      review_agent_type: "dispatch",
    });
    const carried = await pool.query<{ table_name: string; value: string }>(
      `SELECT 'jobs' AS table_name, agent_type AS value FROM jobs WHERE id = 'job_prerelease'
        UNION ALL
       SELECT 'templates', agent_type FROM templates WHERE id = 'tpl_prerelease'
        UNION ALL
       SELECT 'agent_events', agent_type FROM agent_events WHERE agent_id = 'agt_prerelease'
        UNION ALL
       SELECT 'settings', value FROM settings WHERE key = 'enabled_agent_types'
       ORDER BY table_name`
    );
    expect(carried.rows).toEqual([
      { table_name: "agent_events", value: "dispatch" },
      { table_name: "jobs", value: "dispatch" },
      { table_name: "settings", value: '["claude","dispatch","terminal"]' },
      { table_name: "templates", value: "dispatch" },
    ]);
  });
});
