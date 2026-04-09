import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { runner } from "node-pg-migrate";

import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve to src/db/migrations whether running from src/ (tsx) or dist/ (tsc)
const migrationsDir = __dirname.includes("/dist/")
  ? path.resolve(__dirname, "..", "..", "src", "db", "migrations")
  : path.join(__dirname, "migrations");

// Arbitrary fixed key for pg_advisory_lock to prevent concurrent migrations.
const MIGRATION_LOCK_ID = 8675309;

export interface MigrationOptions {
  databaseUrl?: string;
  count?: number;
}

export async function runMigrations(
  optionsOrUrl?: string | MigrationOptions
): Promise<void> {
  const opts: MigrationOptions =
    typeof optionsOrUrl === "string"
      ? { databaseUrl: optionsOrUrl }
      : optionsOrUrl ?? {};

  const url = opts.databaseUrl ?? loadConfig().databaseUrl;

  // Acquire an advisory lock so concurrent server starts don't race migrations
  const lockClient = new pg.Client({ connectionString: url });
  await lockClient.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await runner({
      databaseUrl: url,
      dir: migrationsDir,
      direction: "up",
      migrationsTable: "pgmigrations",
      count: opts.count,
      log: (msg) => console.log(`[migrate] ${msg}`),
    });

    console.log("Migrations completed.");
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => null);
    await lockClient.end().catch(() => null);
  }
}

export { migrationsDir };

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  });
}
