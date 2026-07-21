import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./setup.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations"
);
const pinIdsMigration = "0036_pin-ids.sql";
const pinIdsMigrationIndex = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .indexOf(pinIdsMigration);

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runMigrations({
    databaseUrl: getTestDatabaseUrl(),
    count: pinIdsMigrationIndex,
  });
});

afterAll(async () => {
  await teardownTestDb();
});

describe("0036_pin-ids upgrade", () => {
  it("normalizes malformed legacy pins and assigns usable stable IDs", async () => {
    await pool.query(`
      INSERT INTO agents (id, name, status, cwd, pins) VALUES
        ('pin-valid', 'valid', 'stopped', '/tmp',
          '[{"label":"URL","value":"https://example.com","type":"url"}, {"label":"","value":"legacy-empty-label","type":"string"}]'),
        ('pin-malformed', 'malformed', 'stopped', '/tmp', '{"label":"not-an-array"}'),
        ('pin-mixed', 'mixed', 'stopped', '/tmp',
          '[null, "bad", {"label":"Missing value","type":"url"}, {"label":"Good","value":"v","type":"string"}]'),
        ('pin-duplicates', 'duplicates', 'stopped', '/tmp',
          '[{"id":"same","label":"One","value":"1","type":"string"}, {"id":"same","label":"Two","value":"2","type":"string"}, {"id":"","label":"Three","value":"3","type":"string"}]')
    `);

    await runMigrations(getTestDatabaseUrl());

    const rows = await pool.query<{
      id: string;
      pins: Array<Record<string, string>>;
    }>("SELECT id, pins FROM agents WHERE id LIKE 'pin-%' ORDER BY id");
    const byId = new Map(rows.rows.map((row) => [row.id, row.pins]));

    expect(byId.get("pin-malformed")).toEqual([]);
    expect(byId.get("pin-valid")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "",
          value: "legacy-empty-label",
          id: expect.any(String),
        }),
      ])
    );
    expect(byId.get("pin-mixed")).toEqual([
      expect.objectContaining({
        label: "Good",
        value: "v",
        type: "string",
        id: expect.any(String),
      }),
    ]);

    for (const pin of [
      ...(byId.get("pin-valid") ?? []),
      ...(byId.get("pin-duplicates") ?? []),
    ]) {
      expect(pin.id).toMatch(/^\S+$/);
    }
    const duplicateIds = (byId.get("pin-duplicates") ?? []).map(
      (pin) => pin.id
    );
    expect(new Set(duplicateIds).size).toBe(duplicateIds.length);
  });
});
