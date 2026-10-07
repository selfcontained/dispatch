import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

import { SEED_TAG } from "./constants.js";
import { seedAgents } from "./agents.js";
import { seedTokenUsage } from "./token-usage.js";
import { seedFiles } from "./files.js";
import { seedJobs } from "./jobs.js";
import { PLACEHOLDER_FILES } from "./placeholder-files.js";

type SeedOptions = {
  databaseUrl: string;
  filesRoot: string;
  log?: (msg: string) => void;
};

// Dev databases provisioned by `dispatch-dev` are named `dispatch_<suffix>` where
// `<suffix>` is always an agent id (`agt_<hex>`) or an auto-generated dev tag
// (`dev-<pid>-<timestamp>` / `dev_<pid>_<timestamp>`). This allowlist matches
// those shapes and rejects any other name — including `dispatch`, `dispatch_prod`,
// `postgres`, and arbitrary production DBs.
const DEV_DATABASE_NAME = /^dispatch_(agt_[A-Za-z0-9]+|dev[-_][\w-]+)$/;

function log(options: SeedOptions, msg: string): void {
  (options.log ?? ((m) => console.log(`[seed] ${m}`)))(msg);
}

function assertSafeSeedTarget(databaseUrl: string): void {
  let dbName: string;
  try {
    const url = new URL(databaseUrl);
    dbName = url.pathname.replace(/^\/+/, "");
  } catch {
    throw new Error(
      `Refusing to seed: could not parse DATABASE_URL to verify it targets a dispatch-dev database.`
    );
  }
  if (!DEV_DATABASE_NAME.test(dbName)) {
    throw new Error(
      `Refusing to seed database "${dbName}". ` +
        `Dev seeding only runs against databases provisioned by dispatch-dev ` +
        `(dispatch_agt_<id> or dispatch_dev-<tag>).`
    );
  }
}

async function clearSeeded(client: PoolClient): Promise<void> {
  // Order matters: clear dependents first. CASCADEs handle the rest.
  await client.query(`DELETE FROM job_runs WHERE config->>'seed' = $1`, [
    SEED_TAG,
  ]);
  await client.query(`DELETE FROM jobs WHERE id LIKE 'seed-job-%'`);
  // Deleting agents cascades to files, token usage and stream events.
  await client.query(`DELETE FROM agents WHERE id LIKE 'seed-%'`);
}

export async function seedDevData(
  pool: Pool,
  options: SeedOptions
): Promise<void> {
  assertSafeSeedTarget(options.databaseUrl);
  log(options, `Seeding dev data (tag=${SEED_TAG})...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await clearSeeded(client);
    await seedAgents(client);
    await seedTokenUsage(client);
    await seedFiles(client);
    await seedJobs(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await writePlaceholderFiles(options.filesRoot, log.bind(null, options));
  log(options, "Dev data seeded.");
}

// Minimal 1x1 PNGs so file thumbnails/routes have real bytes on disk.

async function writePlaceholderFiles(
  filesRoot: string,
  report: (msg: string) => void
): Promise<void> {
  for (const { agentId, fileName, base64 } of PLACEHOLDER_FILES) {
    const dir = path.join(filesRoot, agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), Buffer.from(base64, "base64"));
  }
  report(
    `Wrote ${PLACEHOLDER_FILES.length} placeholder files under ${filesRoot}.`
  );
}
