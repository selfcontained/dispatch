import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ARCHIVED_AGENT_RETENTION_SETTING,
  purgeExpiredArchivedAgents,
} from "../src/agents/retention.js";
import { setSetting } from "../src/db/settings.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let filesRoot: string;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => logger,
} as never;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  filesRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-retention-"));
});

afterAll(async () => {
  await teardownTestDb();
  await rm(filesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM settings WHERE key = $1", [
    ARCHIVED_AGENT_RETENTION_SETTING,
  ]);
  await pool.query("DELETE FROM agents");
});

async function seedAgent(
  id: string,
  opts: { archivedDaysAgo?: number | null; parent?: string } = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, deleted_at, parent_agent_id)
     VALUES ($1, $1, 'claude', 'stopped', '/tmp',
             CASE WHEN $2::int IS NULL THEN NULL ELSE now() - ($2::int * interval '1 day') END,
             $3)`,
    [id, opts.archivedDaysAgo ?? null, opts.parent ?? null]
  );
  await pool.query(
    `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
     VALUES ($1, 1, 'assistant', '{}'::jsonb)`,
    [id]
  );
  const dir = path.join(filesRoot, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "shot.png"), "png");
  await pool.query(
    `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
     VALUES ($1, 'shot.png', 'screenshot', 3, 'image/png')`,
    [id]
  );
}

async function seedBlock(streamId: string, author: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO blocks (id, stream_id, author_kind, author_agent_id, text)
     VALUES (gen_random_uuid(), $1, 'agent', $2, 'hi') RETURNING id`,
    [streamId, author]
  );
  await pool.query(
    `INSERT INTO block_reactions (id, block_id, stream_id, author_kind, emoji)
     VALUES (gen_random_uuid(), $1, $2, 'user', '👍')`,
    [row.rows[0]!.id, streamId]
  );
  return row.rows[0]!.id;
}

async function count(table: string, column: string, id: string) {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
    [id]
  );
  return r.rows[0]!.n;
}

describe("purgeExpiredArchivedAgents", () => {
  it("removes an agent archived past the window with its stream and files", async () => {
    await seedAgent("old", { archivedDaysAgo: 40 });
    await seedAgent("child", { archivedDaysAgo: 40, parent: "old" });
    await seedBlock("old", "old");
    await seedBlock("old", "child");
    await seedAgent("recent", { archivedDaysAgo: 3 });
    await seedAgent("live");
    await seedBlock("live", "live");

    const removed = await purgeExpiredArchivedAgents({
      pool,
      logger,
      filesRoot,
    });
    expect(removed.sort()).toEqual(["child", "old"]);

    for (const id of ["old", "child"]) {
      expect(await count("agents", "id", id)).toBe(0);
      expect(await count("agent_stream_events", "agent_id", id)).toBe(0);
      expect(await count("files", "agent_id", id)).toBe(0);
      await expect(stat(path.join(filesRoot, id))).rejects.toThrow();
    }
    expect(await count("blocks", "stream_id", "old")).toBe(0);
    expect(await count("block_reactions", "stream_id", "old")).toBe(0);

    for (const id of ["recent", "live"]) {
      expect(await count("agents", "id", id)).toBe(1);
      await expect(stat(path.join(filesRoot, id))).resolves.toBeTruthy();
    }
    expect(await count("blocks", "stream_id", "live")).toBe(1);
  });

  it("honours the setting, and 0 keeps everything", async () => {
    await seedAgent("week", { archivedDaysAgo: 8 });
    await setSetting(pool, ARCHIVED_AGENT_RETENTION_SETTING, "0");
    expect(
      await purgeExpiredArchivedAgents({ pool, logger, filesRoot })
    ).toEqual([]);
    expect(await count("agents", "id", "week")).toBe(1);

    await setSetting(pool, ARCHIVED_AGENT_RETENTION_SETTING, "7");
    expect(
      await purgeExpiredArchivedAgents({ pool, logger, filesRoot })
    ).toEqual(["week"]);
  });

  it("does nothing when nothing has expired", async () => {
    await seedAgent("fresh", { archivedDaysAgo: 1 });
    expect(
      await purgeExpiredArchivedAgents({ pool, logger, filesRoot })
    ).toEqual([]);
  });
});
