import path from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve to src/db/migrations whether running from src/ (tsx) or dist/ (tsc)
const migrationsDir = __dirname.includes("/dist/")
  ? path.resolve(__dirname, "..", "..", "src", "db", "migrations")
  : path.join(__dirname, "migrations");

export async function runMigrations(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? loadConfig().databaseUrl;

  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    log: (msg) => console.log(`[migrate] ${msg}`),
  });

  console.log("Migrations completed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  });
}
