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

    // 0010_remove_launch_guidance_setting shipped alongside
    // 0010_browser_feedback_blocks before it was renumbered to 0011. Existing
    // databases already ran its SQL, but node-pg-migrate treats the new name
    // as an unapplied migration before the old, applied name and refuses to
    // start. Rename only the recorded migration; its schema change is done.
    const migrationTable = await lockClient.query<{ name: string | null }>(
      "SELECT to_regclass('pgmigrations') AS name"
    );
    if (migrationTable.rows[0]?.name) {
      const renamed = await lockClient.query(
        `UPDATE pgmigrations
         SET name = '0011_remove_launch_guidance_setting'
         WHERE name = '0010_remove_launch_guidance_setting'
           AND EXISTS (
             SELECT 1 FROM pgmigrations
             WHERE name = '0010_browser_feedback_blocks'
           )
           AND NOT EXISTS (
             SELECT 1 FROM pgmigrations
             WHERE name = '0011_remove_launch_guidance_setting'
           )`
      );
      if (renamed.rowCount) {
        console.log("[migrate] Recorded launch guidance migration as 0011.");
      }
    }

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
