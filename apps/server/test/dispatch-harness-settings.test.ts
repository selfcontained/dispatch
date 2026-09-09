import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  isDispatchHarnessEnabled,
  setDispatchHarnessEnabled,
} from "../src/dispatch-harness-settings.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query(
    "DELETE FROM settings WHERE key = 'dispatch_harness_enabled'"
  );
});

describe("the Dispatch Harness flag", () => {
  it("reads false on an install that has never set it", async () => {
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });

  it("round trips true, then back to false", async () => {
    await setDispatchHarnessEnabled(pool, true);
    expect(await isDispatchHarnessEnabled(pool)).toBe(true);

    await setDispatchHarnessEnabled(pool, false);
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });

  // The column is text, so anything could be in there. Only the exact
  // string the setter writes counts as on.
  it("reads false for a stored value that is not the string true", async () => {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('dispatch_harness_enabled', 'yes')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });
});
