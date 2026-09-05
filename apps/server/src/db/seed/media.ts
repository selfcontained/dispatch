import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";
import { PLACEHOLDER_MEDIA } from "./index.js";

type MediaRow = {
  agentId: string;
  fileName: string;
  source: "screenshot" | "text" | "simulator" | "stream";
  sizeBytes: number;
  description: string;
  hoursAgo: number;
  width: number;
  height: number;
};

const DESCRIPTIONS = [
  "Activity heatmap — daily view",
  "Activity heatmap — hourly breakdown",
  "Empty-state treatment",
];

// Derived from the same table index.ts::writePlaceholderMedia writes the files
// from, so a row's stored shape always matches the bytes on disk.
const ROWS: MediaRow[] = PLACEHOLDER_MEDIA.map((placeholder, index) => ({
  agentId: placeholder.agentId,
  fileName: placeholder.fileName,
  source: "screenshot",
  sizeBytes: Buffer.from(placeholder.base64, "base64").length,
  description: DESCRIPTIONS[index] ?? placeholder.fileName,
  hoursAgo: index + 1,
  width: placeholder.width,
  height: placeholder.height,
}));

function ago(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function seedMedia(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const row of ROWS) {
    await client.query(
      `
      INSERT INTO media (agent_id, file_name, source, size_bytes, description, created_at, updated_at, width, height)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)
      `,
      [
        row.agentId,
        row.fileName,
        row.source,
        row.sizeBytes,
        row.description,
        ago(now, row.hoursAgo),
        row.width,
        row.height,
      ]
    );
  }
}
