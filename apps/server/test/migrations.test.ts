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
    await pool.query("DROP TABLE block_delivery_context");
    await pool.query("DROP TABLE scheduled_messages");
    await pool.query(
      `DELETE FROM pgmigrations WHERE name IN ('0016_block_reactions_pg14_unique', '0017_scheduled_messages', '0018_message_context')`
    );

    await runTestMigrations();

    const state = await reactionUniqueness();
    expect(state.constraints).toEqual([]);
    expect(state.index).toContain("COALESCE(author_agent_id, ''::text)");
  });
});
