import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type MediaRow = {
  agentId: string;
  fileName: string;
  source: "screenshot" | "text" | "simulator" | "stream";
  sizeBytes: number;
  description: string;
  hoursAgo: number;
};

// The placeholder PNGs on disk are written by index.ts::writePlaceholderMedia —
// these DB rows must match those file paths.
const ROWS: MediaRow[] = [
  {
    agentId: "seed-agent-running-feature",
    fileName: "seed-screenshot-1.png",
    source: "screenshot",
    sizeBytes: 138,
    description: "Activity heatmap — daily view",
    hoursAgo: 1,
  },
  {
    agentId: "seed-agent-running-feature",
    fileName: "seed-screenshot-2.png",
    source: "screenshot",
    sizeBytes: 138,
    description: "Activity heatmap — hourly breakdown",
    hoursAgo: 2,
  },
  {
    agentId: "seed-agent-running-feature",
    fileName: "seed-screenshot-3.png",
    source: "screenshot",
    sizeBytes: 138,
    description: "Empty-state treatment",
    hoursAgo: 3,
  },
];

function ago(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function seedMedia(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const row of ROWS) {
    await client.query(
      `
      INSERT INTO media (agent_id, file_name, source, size_bytes, description, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6)
      `,
      [
        row.agentId,
        row.fileName,
        row.source,
        row.sizeBytes,
        row.description,
        ago(now, row.hoursAgo),
      ]
    );
  }
}
