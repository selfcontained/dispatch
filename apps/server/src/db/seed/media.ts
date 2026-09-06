import type { PoolClient } from "pg";

import type { MediaMetadata } from "../../media/metadata.js";
import { mediaMetadataFromBuffer } from "../../media/metadata.js";

import { seedNow } from "./constants.js";
import { PLACEHOLDER_MEDIA } from "./placeholder-media.js";

type MediaRow = {
  agentId: string;
  fileName: string;
  source: "screenshot" | "text" | "simulator" | "stream";
  sizeBytes: number;
  description: string;
  hoursAgo: number;
  metadata: MediaMetadata;
};

// Built from the same table index.ts::writePlaceholderMedia writes the files
// from. Size and shape are measured off those same bytes, so a seeded row
// describes the file it points at by construction; everything else comes from
// the placeholder's own entry rather than a lookup by position.
const ROWS: MediaRow[] = PLACEHOLDER_MEDIA.map((placeholder) => {
  const bytes = Buffer.from(placeholder.base64, "base64");
  return {
    agentId: placeholder.agentId,
    fileName: placeholder.fileName,
    source: "screenshot" as const,
    sizeBytes: bytes.length,
    description: placeholder.description,
    hoursAgo: placeholder.hoursAgo,
    metadata: mediaMetadataFromBuffer(bytes),
  };
});

function ago(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function seedMedia(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const row of ROWS) {
    await client.query(
      `
      INSERT INTO media (agent_id, file_name, source, size_bytes, description, created_at, updated_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7)
      `,
      [
        row.agentId,
        row.fileName,
        row.source,
        row.sizeBytes,
        row.description,
        ago(now, row.hoursAgo),
        row.metadata,
      ]
    );
  }
}
