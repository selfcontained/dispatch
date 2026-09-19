import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  activatePersonality,
  getActivePersonality,
  getPersonality,
  listPersonalities,
} from "../src/db/personalities.js";
import { BUILT_IN_PERSONALITIES } from "../src/personalities/built-in.js";

const ECONOMY = BUILT_IN_PERSONALITIES[0]!;

type Row = {
  id: string;
  name: string;
  prompt: string;
  created_at: Date;
  updated_at: Date;
};

function row(id: string, name: string): Row {
  return {
    id,
    name,
    prompt: `${name} prompt`,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

/**
 * A pool that answers the three shapes this module issues: the list SELECT,
 * the single-row SELECT, and the settings read/write behind the active id.
 */
function createPool(rows: Row[], settings: Record<string, string> = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM personalities WHERE id")) {
      const found = rows.filter((r) => r.id === values?.[0]);
      return { rows: found, rowCount: found.length };
    }
    if (sql.includes("FROM personalities")) {
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM settings") || sql.includes("settings")) {
      const key = String(values?.[0] ?? "");
      const value = settings[key];
      return value === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, query, settings };
}

describe("built-in personalities", () => {
  it("ships economy with the ladder and the safety carve-out inside the cap", () => {
    expect(ECONOMY.id).toBe("economy");
    expect(ECONOMY.prompt.length).toBeLessThanOrEqual(1000);
    // The carve-out is the reason the ladder is safe to ship, so it is pinned
    // rather than left to survive a future edit for space.
    expect(ECONOMY.prompt).toContain("trust boundary");
    expect(ECONOMY.prompt).toContain("accessibility");
  });

  it("lists built-ins ahead of stored rows", async () => {
    const { pool } = createPool([row("uuid-1", "Mine")]);
    const listed = await listPersonalities(pool);
    expect(listed.map((p) => p.id)).toEqual(["economy", "uuid-1"]);
  });

  it("lets a stored row of the same id replace the built-in", async () => {
    const { pool } = createPool([row("economy", "My economy")]);
    const listed = await listPersonalities(pool);
    expect(listed.map((p) => p.id)).toEqual(["economy"]);
    expect(listed[0]!.name).toBe("My economy");
  });

  it("resolves a built-in through getPersonality when no row exists", async () => {
    const { pool } = createPool([]);
    await expect(getPersonality(pool, "economy")).resolves.toMatchObject({
      id: "economy",
    });
    await expect(getPersonality(pool, "nope")).resolves.toBeNull();
  });

  it("activates a built-in that has no row to lock", async () => {
    const { pool, query } = createPool([]);
    await expect(activatePersonality(pool, "economy")).resolves.toBe(true);
    const wrote = query.mock.calls.some(
      ([sql, values]) =>
        String(sql).includes("settings") &&
        (values as unknown[] | undefined)?.includes("economy")
    );
    expect(wrote).toBe(true);
  });

  it("reaches the launch path: an active built-in resolves to its prompt", async () => {
    const { pool } = createPool([], { active_personality_id: "economy" });
    const active = await getActivePersonality(pool);
    expect(active?.prompt).toBe(ECONOMY.prompt);
  });
});
