import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  DEFAULT_ENABLED_AGENT_TYPES,
  getOfferedAgentTypes,
} from "../src/agent-type-settings.js";
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
    "DELETE FROM settings WHERE key IN ('dispatch_harness_enabled', 'enabled_agent_types')"
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

/** Write the persisted enabled-types row directly, bypassing the sanitizer. */
async function seedEnabledAgentTypes(types: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(types)]
  );
}

describe("getOfferedAgentTypes", () => {
  it("is the enabled types with the flag off", async () => {
    await seedEnabledAgentTypes(["claude", "codex"]);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude", "codex"]);
  });

  it("adds the harness with the flag on", async () => {
    await seedEnabledAgentTypes(["claude", "codex"]);
    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      "claude",
      "codex",
      "dispatch",
    ]);
  });

  it("drops the harness again when the flag goes off", async () => {
    await seedEnabledAgentTypes(["claude"]);
    await setDispatchHarnessEnabled(pool, true);
    await setDispatchHarnessEnabled(pool, false);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude"]);
  });

  it("offers the harness on an install that never saved a type choice", async () => {
    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      ...DEFAULT_ENABLED_AGENT_TYPES,
      "dispatch",
    ]);
  });

  // A prerelease database carries `dispatch` inside the stored JSON (see
  // db/migrate.ts's one-time rename). Nothing rewrites the row, so the read
  // has to be what keeps the flag the only source, with no duplicate member
  // when the flag is on.
  it("never doubles the harness from a stale persisted row", async () => {
    await seedEnabledAgentTypes(["claude", "dispatch", "terminal"]);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude", "terminal"]);

    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      "claude",
      "terminal",
      "dispatch",
    ]);
  });
});
