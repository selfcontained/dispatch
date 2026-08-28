import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

import { SEED_TAG } from "./constants.js";
import { seedAgents } from "./agents.js";
import { seedActivityEvents } from "./activity.js";
import { seedTokenUsage } from "./token-usage.js";
import { seedMedia } from "./media.js";
import { seedJobs } from "./jobs.js";
import { seedReviews } from "./reviews.js";
import { seedSurfaces } from "./surfaces.js";

type SeedOptions = {
  databaseUrl: string;
  mediaRoot: string;
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
  await client.query(`DELETE FROM reviews WHERE agent_id LIKE 'seed-%'`);
  await client.query(`DELETE FROM agent_events WHERE metadata->>'seed' = $1`, [
    SEED_TAG,
  ]);
  // Legacy e2e fixture tag — clear alongside so dev DBs don't accumulate stale rows.
  await client.query(`DELETE FROM agent_events WHERE metadata->>'seed' = $1`, [
    "activity-demo",
  ]);
  // Deleting agents cascades to media, token usage, events, and reviews.
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
    await seedSurfaces(client);
    await seedActivityEvents(client);
    await seedTokenUsage(client);
    await seedReviews(client);
    await seedMedia(client);
    await seedJobs(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await writePlaceholderMedia(options.mediaRoot, log.bind(null, options));
  log(options, "Dev data seeded.");
}

// Minimal 1x1 PNGs so media thumbnails/routes have real bytes on disk.
async function writePlaceholderMedia(
  mediaRoot: string,
  report: (msg: string) => void
): Promise<void> {
  // 1x1 transparent PNG
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3D7wAAAAASUVORK5CYII=",
    "base64"
  );
  const placements: Array<{ agentId: string; fileName: string }> = [
    {
      agentId: "seed-agent-running-feature",
      fileName: "seed-screenshot-1.png",
    },
    {
      agentId: "seed-agent-running-feature",
      fileName: "seed-screenshot-2.png",
    },
    {
      agentId: "seed-agent-running-feature",
      fileName: "seed-screenshot-3.png",
    },
  ];
  for (const { agentId, fileName } of placements) {
    const dir = path.join(mediaRoot, agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), pngBytes);
  }
  report(
    `Wrote ${placements.length} placeholder media files under ${mediaRoot}.`
  );
}
