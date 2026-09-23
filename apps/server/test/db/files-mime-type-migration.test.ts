import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("0007_files_mime_type", () => {
  it("types the rows stored before it by their extension, then requires a type", async () => {
    await runMigrations({ databaseUrl: getTestDatabaseUrl(), count: 6 });
    await pool.query(
      `INSERT INTO agents (id, name, status, cwd)
       VALUES ('agt_old', 'Old', 'stopped', '/tmp')`
    );
    await pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes) VALUES
         ('agt_old', 'shot.PNG', 'screenshot', 1),
         ('agt_old', 'frame.jpeg', 'stream', 1),
         ('agt_old', 'clip.mp4', 'screenshot', 1),
         ('agt_old', 'brief.pdf', 'user', 1),
         ('agt_old', 'notes.md', 'text', 1),
         ('agt_old', 'data.json', 'text', 1),
         ('agt_old', 'main.ts', 'text', 1)`
    );

    await runMigrations({ databaseUrl: getTestDatabaseUrl() });

    const rows = await pool.query<{ file_name: string; mime_type: string }>(
      `SELECT file_name, mime_type FROM files ORDER BY file_name`
    );
    expect(
      Object.fromEntries(rows.rows.map((r) => [r.file_name, r.mime_type]))
    ).toEqual({
      "brief.pdf": "application/pdf",
      "clip.mp4": "video/mp4",
      "data.json": "application/json",
      "frame.jpeg": "image/jpeg",
      "main.ts": "text/plain",
      "notes.md": "text/markdown",
      "shot.PNG": "image/png",
    });

    await expect(
      pool.query(
        `INSERT INTO files (agent_id, file_name, source, size_bytes)
         VALUES ('agt_old', 'untyped.png', 'screenshot', 1)`
      )
    ).rejects.toThrow(/mime_type/);
  });
});
