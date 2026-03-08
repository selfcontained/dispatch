import { loadConfig } from "../config.js";
import { createPool } from "./client.js";

export async function runMigrations(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  const sql = `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      tmux_session TEXT,
      simulator_udid TEXT,
      media_dir TEXT,
      codex_args JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS media_dir TEXT;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS codex_args JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS last_error TEXT;

    CREATE TABLE IF NOT EXISTS simulator_reservations (
      udid TEXT PRIMARY KEY,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'free',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  try {
    await pool.query(sql);
    console.log("Migrations completed.");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  });
}
