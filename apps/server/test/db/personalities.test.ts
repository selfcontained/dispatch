import { beforeEach, describe, expect, it } from "vitest";

import {
  deletePersonality,
  getActivePersonalityId,
} from "../../src/db/personalities.js";
import { useInjectApp } from "../helpers/inject-app.js";

const ctx = useInjectApp();

beforeEach(async () => {
  await ctx.pool.query(
    "DELETE FROM settings WHERE key = 'active_personality_id'"
  );
  await ctx.pool.query("DELETE FROM personalities");
});

async function waitForDeleteToBlock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await ctx.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE query = 'DELETE FROM personalities WHERE id = $1 RETURNING id'
           AND wait_event_type = 'Lock'
       ) AS waiting`
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for personality deletion to block.");
}

describe("deletePersonality", () => {
  it("clears an activation committed while deletion waits on the personality lock", async () => {
    const id = "personality-race";
    await ctx.pool.query(
      "INSERT INTO personalities (id, name, prompt) VALUES ($1, 'Race', 'Prompt')",
      [id]
    );

    const activation = await ctx.pool.connect();
    try {
      await activation.query("BEGIN");
      await activation.query(
        "SELECT id FROM personalities WHERE id = $1 FOR UPDATE",
        [id]
      );

      const deleting = deletePersonality(ctx.pool, id);
      await waitForDeleteToBlock();

      await activation.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('active_personality_id', $1, NOW())
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
        [id]
      );
      await activation.query("COMMIT");

      expect(await deleting).toBe(true);
      expect(await getActivePersonalityId(ctx.pool)).toBeNull();
    } finally {
      await activation.query("ROLLBACK").catch(() => undefined);
      activation.release();
    }
  });
});
