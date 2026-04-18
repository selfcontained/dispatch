// Standalone CLI: seed demo data into a dispatch-dev database.
//
// Invoked by `dispatch-dev up` — not by the server runtime. Reads DATABASE_URL
// and MEDIA_ROOT from the environment (the same variables dispatch-dev sets
// for the server process) and refuses to run against any non-dev database.
//
// Usage:
//   DATABASE_URL=postgres://.../dispatch_dev-xyz MEDIA_ROOT=/tmp/... \
//     tsx apps/server/src/db/seed/run.ts

import path from "node:path";

import pg from "pg";

import { runMigrations } from "../migrate.js";
import { seedDevData } from "./index.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  const mediaRoot =
    process.env.MEDIA_ROOT ??
    path.join(process.env.HOME ?? "/tmp", ".dispatch", "media");

  // Migrations are idempotent and take an advisory lock, so running them here
  // before the server boots is safe — when the server then runs its own
  // migration pass it will find nothing to do.
  await runMigrations(databaseUrl);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await seedDevData(pool, { databaseUrl, mediaRoot });
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
