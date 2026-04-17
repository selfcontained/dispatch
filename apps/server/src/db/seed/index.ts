import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

import { SEED_TAG } from "./constants.js";
import { seedAgents } from "./agents.js";
import { seedActivityEvents } from "./activity.js";
import { seedTokenUsage } from "./token-usage.js";
import { seedFeedback } from "./feedback.js";
import { seedMedia } from "./media.js";
import { seedJobs } from "./jobs.js";
import { seedPersonaReviews } from "./persona-reviews.js";

type SeedOptions = {
  databaseUrl: string;
  mediaRoot: string;
  log?: (msg: string) => void;
};

const PROD_DATABASE_NAMES = new Set(["dispatch"]);

function log(options: SeedOptions, msg: string): void {
  (options.log ?? ((m) => console.log(`[seed] ${m}`)))(msg);
}

function assertNotProduction(databaseUrl: string): void {
  try {
    const url = new URL(databaseUrl);
    const dbName = url.pathname.replace(/^\/+/, "");
    if (PROD_DATABASE_NAMES.has(dbName)) {
      throw new Error(
        `Refusing to seed production database "${dbName}". ` +
          `Dev seeding is only allowed against isolated dev databases.`
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("Refusing to seed production")
    ) {
      throw err;
    }
    // URL parse failure — let the pool connection surface that.
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production.");
  }
}

async function clearSeeded(client: PoolClient): Promise<void> {
  // Order matters: clear dependents first. CASCADEs handle the rest.
  await client.query(
    `DELETE FROM job_runs WHERE config::text LIKE '%"seed":"${SEED_TAG}"%'`
  );
  await client.query(`DELETE FROM jobs WHERE id LIKE 'seed-job-%'`);
  await client.query(
    `DELETE FROM persona_reviews WHERE agent_id LIKE 'seed-%'`
  );
  await client.query(
    `DELETE FROM agent_events WHERE metadata::text LIKE '%"seed":"${SEED_TAG}"%'`
  );
  await client.query(
    `DELETE FROM agent_events WHERE metadata::text LIKE '%"seed":"activity-demo"%'`
  );
  // Deleting agents cascades to media, feedback, token usage, events, persona_reviews.
  await client.query(`DELETE FROM agents WHERE id LIKE 'seed-%'`);
}

export async function seedDevData(
  pool: Pool,
  options: SeedOptions
): Promise<void> {
  assertNotProduction(options.databaseUrl);
  log(options, `Seeding dev data (tag=${SEED_TAG})...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await clearSeeded(client);
    await seedAgents(client);
    await seedActivityEvents(client);
    await seedTokenUsage(client);
    await seedFeedback(client);
    await seedMedia(client);
    await seedJobs(client);
    await seedPersonaReviews(client);
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
    { agentId: "seed-agent-blocked", fileName: "seed-repro.png" },
    { agentId: "seed-agent-history-1", fileName: "seed-history-1.png" },
    { agentId: "seed-agent-history-1", fileName: "seed-history-2.png" },
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
