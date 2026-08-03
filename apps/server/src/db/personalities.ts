import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { deleteSetting, getSetting, setSetting } from "./settings.js";

const ACTIVE_PERSONALITY_KEY = "active_personality_id";

export type Personality = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

type PersonalityRow = {
  id: string;
  name: string;
  prompt: string;
  created_at: Date;
  updated_at: Date;
};

function rowToPersonality(row: PersonalityRow): Personality {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listPersonalities(pool: Pool): Promise<Personality[]> {
  const result = await pool.query<PersonalityRow>(
    "SELECT id, name, prompt, created_at, updated_at FROM personalities ORDER BY created_at ASC"
  );
  return result.rows.map(rowToPersonality);
}

export async function getPersonality(
  pool: Pool,
  id: string
): Promise<Personality | null> {
  const result = await pool.query<PersonalityRow>(
    "SELECT id, name, prompt, created_at, updated_at FROM personalities WHERE id = $1",
    [id]
  );
  const row = result.rows[0];
  return row ? rowToPersonality(row) : null;
}

export async function createPersonality(
  pool: Pool,
  input: { name: string; prompt: string }
): Promise<Personality> {
  const id = randomUUID();
  const result = await pool.query<PersonalityRow>(
    `INSERT INTO personalities (id, name, prompt)
     VALUES ($1, $2, $3)
     RETURNING id, name, prompt, created_at, updated_at`,
    [id, input.name, input.prompt]
  );
  return rowToPersonality(result.rows[0]!);
}

export async function updatePersonality(
  pool: Pool,
  id: string,
  input: { name?: string; prompt?: string }
): Promise<Personality | null> {
  const result = await pool.query<PersonalityRow>(
    `UPDATE personalities
     SET name = COALESCE($2, name),
         prompt = COALESCE($3, prompt),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, prompt, created_at, updated_at`,
    [id, input.name ?? null, input.prompt ?? null]
  );
  const row = result.rows[0];
  return row ? rowToPersonality(row) : null;
}

export async function deletePersonality(
  pool: Pool,
  id: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // This statement waits for activatePersonality's row lock when needed.
    // The separate settings DELETE gets a fresh READ COMMITTED snapshot after
    // that wait, ensuring it sees an activation that committed meanwhile.
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM personalities WHERE id = $1 RETURNING id",
      [id]
    );
    if (deleted.rowCount === 0) {
      await client.query("COMMIT");
      return false;
    }
    await client.query("DELETE FROM settings WHERE key = $1 AND value = $2", [
      ACTIVE_PERSONALITY_KEY,
      id,
    ]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getActivePersonalityId(
  pool: Pool
): Promise<string | null> {
  const value = await getSetting(pool, ACTIVE_PERSONALITY_KEY);
  return value && value.length > 0 ? value : null;
}

export async function setActivePersonalityId(
  pool: Pool,
  id: string | null
): Promise<void> {
  if (id === null) {
    await deleteSetting(pool, ACTIVE_PERSONALITY_KEY);
    return;
  }
  await setSetting(pool, ACTIVE_PERSONALITY_KEY, id);
}

/**
 * Set the active personality only while holding a row lock on it. Deletion
 * acquires that same row lock before it clears the active setting, so a delete
 * cannot interleave and leave a dangling active_personality_id behind.
 */
export async function activatePersonality(
  pool: Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query<{ activated: boolean }>(
    `WITH locked AS (
       SELECT id FROM personalities WHERE id = $1 FOR UPDATE
     ),
     activated AS (
       INSERT INTO settings (key, value, updated_at)
       SELECT '${ACTIVE_PERSONALITY_KEY}', id, NOW() FROM locked
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM activated) AS activated`,
    [id]
  );
  return result.rows[0]?.activated ?? false;
}

export async function getActivePersonality(
  pool: Pool
): Promise<Personality | null> {
  const id = await getActivePersonalityId(pool);
  if (!id) return null;
  return getPersonality(pool, id);
}
