import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import pg from "pg";
import { runner } from "node-pg-migrate";

import { loadConfig } from "../config.js";
import { migrationFiles } from "../generated/runtime-assets.js";

// Arbitrary fixed key for pg_advisory_lock to prevent concurrent migrations.
const MIGRATION_LOCK_ID = 8675309;

const TIMESTAMP_PARSE_NOISE_RE = /^Can't determine timestamp for \d+$/;

/**
 * Bookkeeping names written into `pgmigrations` under file names this
 * branch does not ship. Most are from earlier prereleases of this branch;
 * the schema those files created is the schema `0051_agent-stream-events.sql`
 * and `0052_agent-chat-messages-delivery-text.sql` create now. The last one
 * is from the v0.38.14 release on main, which numbered the reactions table
 * 0051 — the number this branch gives its stream-events file — and which
 * this branch ships as `0057_agent-chat-reactions.sql`. Every one of those
 * files re-applies idempotently (every statement is guarded), so the dead
 * records are deleted before the runner reads the table. No migration can
 * repair this from the inside: node-pg-migrate compares the stored list
 * against the shipped files position by position and throws before the
 * first migration executes.
 */
const PRERELEASE_MIGRATION_NAMES = [
  "0048_agent-stream-events",
  "0049_agent-stream-events-turn",
  "0050_agent-chat-messages-delivery-text",
  "0051_agent-type-dispatch",
  "0052_agent-stream-events-turn",
  "0053_agent-chat-messages-delivery-text",
  "0054_agent-type-dispatch",
  "0051_agent-chat-reactions",
];

/**
 * Every place the deleted prerelease migration rewrote when the harness
 * agent type was renamed: agents, an agent's saved reviewer type, jobs,
 * templates, the event log, and the enabled-types setting (a JSON array
 * held as text). A value left behind is one no code recognizes, which reads
 * as the harness quietly disappearing from that row rather than as an
 * error. The old value below is a data literal, and this is the one place
 * in the tree where the old name appears.
 */
const PRERELEASE_TYPE_RENAMES = [
  "UPDATE agents SET type = 'dispatch' WHERE type = 'dsh'",
  "UPDATE agents SET review_agent_type = 'dispatch' WHERE review_agent_type = 'dsh'",
  "UPDATE jobs SET agent_type = 'dispatch' WHERE agent_type = 'dsh'",
  "UPDATE templates SET agent_type = 'dispatch' WHERE agent_type = 'dsh'",
  "UPDATE agent_events SET agent_type = 'dispatch' WHERE agent_type = 'dsh'",
  // No settings row means nobody saved a choice, so this is a no-op then.
  `UPDATE settings
      SET value = replace(value, '"dsh"', '"dispatch"'), updated_at = NOW()
    WHERE key = 'enabled_agent_types' AND value LIKE '%"dsh"%'`,
];

/**
 * Delete the prerelease bookkeeping records and, when there were any, carry
 * over the agent type rename one of those prereleases shipped as a
 * migration of its own. Call inside the migration advisory lock, before the
 * runner.
 */
async function forgetPrereleaseMigrations(client: pg.Client): Promise<void> {
  const table = await client.query<{ oid: string | null }>(
    "SELECT to_regclass('pgmigrations')::text AS oid"
  );
  if (!table.rows[0]?.oid) return; // fresh database: nothing to forget

  const forgotten = await client.query(
    "DELETE FROM pgmigrations WHERE name = ANY($1::text[])",
    [PRERELEASE_MIGRATION_NAMES]
  );
  if (!forgotten.rowCount) return;
  console.log(
    `[migrate] forgot ${forgotten.rowCount} prerelease migration record(s)`
  );

  // Those prereleases stored the harness agent type under an older value and
  // renamed it in a migration this branch does not ship, so the rename is
  // carried over here. Only reached when a record was deleted just above,
  // which means the database ran a prerelease and every column below
  // exists.
  let renamed = 0;
  for (const sql of PRERELEASE_TYPE_RENAMES) {
    const result = await client.query(sql);
    renamed += result.rowCount ?? 0;
  }
  if (renamed) {
    console.log(`[migrate] carried the type rename to ${renamed} row(s)`);
  }
}

export interface MigrationOptions {
  databaseUrl?: string;
  count?: number;
}

export function shouldLogMigrationMessage(msg: string): boolean {
  return !TIMESTAMP_PARSE_NOISE_RE.test(msg);
}

async function materializeEmbeddedMigrations(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-migrations-"));
  await Promise.all(
    migrationFiles.map(async (migration) => {
      await writeFile(path.join(tempDir, migration.name), migration.sql);
    })
  );
  return tempDir;
}

export async function runMigrations(
  optionsOrUrl?: string | MigrationOptions
): Promise<void> {
  const opts: MigrationOptions =
    typeof optionsOrUrl === "string"
      ? { databaseUrl: optionsOrUrl }
      : (optionsOrUrl ?? {});

  const url = opts.databaseUrl ?? loadConfig().databaseUrl;

  // Acquire an advisory lock so concurrent server starts don't race migrations
  const lockClient = new pg.Client({ connectionString: url });
  await lockClient.connect();
  const migrationsDir = await materializeEmbeddedMigrations();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await forgetPrereleaseMigrations(lockClient);

    await runner({
      databaseUrl: url,
      dir: migrationsDir,
      direction: "up",
      migrationsTable: "pgmigrations",
      count: opts.count,
      log: (msg) => {
        if (shouldLogMigrationMessage(msg)) {
          console.log(`[migrate] ${msg}`);
        }
      },
    });

    console.log("Migrations completed.");
  } finally {
    await rm(migrationsDir, { recursive: true, force: true }).catch(() => null);
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .catch(() => null);
    await lockClient.end().catch(() => null);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  });
}
